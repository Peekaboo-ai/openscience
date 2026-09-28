import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { RuntimeEvents } from "../../src/runtime/events"
import { RuntimeRuns } from "../../src/runtime/runs"
import { RuntimeQueue } from "../../src/runtime/queue"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }

function provider() {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: unknown }
      const text = JSON.stringify(body.messages)
      requests.push(text)
      const chunk = (content?: string) => ({
        id: "chatcmpl-legacy",
        object: "chat.completion.chunk",
        created: 1,
        model: STRESS_PROVIDER_MODEL,
        choices: [
          { index: 0, delta: content ? { role: "assistant", content } : {}, finish_reason: content ? null : "stop" },
        ],
        ...(!content ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
      })
      return new Response(
        `data: ${JSON.stringify(chunk(text.includes("LATE_GUIDE") ? "GUIDE_APPLIED" : "FIRST_REPLY"))}\n\ndata: ${JSON.stringify(chunk())}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return {
    requests,
    config: stressProviderConfig(`${server.url.origin}/v1`),
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

async function init() {
  await trustProject()
  await Provider.invalidate()
}

test("legacy root submissions share a durable receipt and exact retries do not call the provider", async () => {
  using local = provider()
  await using tmp = await tmpdir({ git: true, config: local.config })
  await Instance.provide({
    directory: tmp.path,
    init,
    async fn() {
      const session = await Session.create({ title: "Legacy receipt fixture" })
      const input = {
        sessionID: session.id,
        messageID: Identifier.ascending("message"),
        model,
        delegation: false,
        parts: [{ type: "text" as const, text: "FIRST_INPUT" }],
      }
      const result = await SessionPrompt.submit(input)
      const calls = local.requests.length
      expect(calls).toBeGreaterThan(0)
      expect((await SessionPrompt.submit(input)).info.id).toBe(result.info.id)
      expect(local.requests).toHaveLength(calls)
      expect(await RuntimeRuns.list(session.id)).toMatchObject([
        {
          state: "completed",
          messageID: input.messageID,
          resultMessageID: result.info.id,
        },
      ])
      expect(
        (await Session.messages({ sessionID: session.id })).filter((item) => item.info.role === "user"),
      ).toHaveLength(1)
      await expect(
        SessionPrompt.submit({ ...input, parts: [{ type: "text", text: "CHANGED_INPUT" }] }),
      ).rejects.toBeInstanceOf(RuntimeRuns.ConflictError)
    },
  })
}, 20_000)

test("disposing the project at settlement waits for the receipt and pauses the queue", async () => {
  using local = provider()
  await using tmp = await tmpdir({ git: true, config: local.config })
  await Instance.provide({
    directory: tmp.path,
    init,
    async fn() {
      const session = await Session.create({ title: "Disposal boundary fixture" })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      using hooks = RuntimeRuns.testing({
        async beforeSettle() {
          entered.resolve()
          await release.promise
        },
      })
      const pending = SessionPrompt.submit({
        sessionID: session.id,
        model,
        delegation: false,
        parts: [{ type: "text", text: "FIRST_INPUT" }],
      }).catch((error: unknown) => error)
      await entered.promise
      const calls = local.requests.length
      await RuntimeQueue.enqueue({
        sessionID: session.id,
        model,
        delegation: false,
        effort: "normal",
        requestID: "after-disposal",
        message: "MUST_NOT_RUN",
      })
      const disposed = Instance.dispose({ strict: true })
      queueMicrotask(() => release.resolve())
      await disposed
      expect(await pending).toBeInstanceOf(Error)
      expect(local.requests).toHaveLength(calls)
      await Instance.provide({
        directory: tmp.path,
        async fn() {
          expect(await RuntimeQueue.get(session.id)).toMatchObject({
            paused: true,
            reason: "runtime_stopped",
            items: [{ input: { message: "MUST_NOT_RUN" } }],
          })
          expect(await RuntimeRuns.list(session.id)).toMatchObject([{ state: "failed" }])
        },
      })
    },
  })
}, 20_000)

test("the adapter retains the configured default agent, internal prompt data and write-only submissions", async () => {
  using local = provider()
  await using tmp = await tmpdir({
    git: true,
    config: {
      ...local.config,
      default_agent: "fixture",
      agent: { fixture: { mode: "primary", description: "Local fixture", prompt: "CUSTOM_AGENT_SYSTEM" } },
      command: { fixture: { description: "Local fixture command", template: "COMMAND_INPUT $ARGUMENTS" } },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init,
    async fn() {
      const session = await Session.create({ title: "Internal adapter fixture" })
      const written = await SessionPrompt.submit({
        sessionID: session.id,
        model,
        noReply: true,
        parts: [{ type: "text", text: "WRITE_ONLY" }],
      })
      expect(written.info.role).toBe("user")
      expect(await RuntimeRuns.list(session.id)).toHaveLength(0)
      expect(local.requests).toHaveLength(0)
      const result = await SessionPrompt.submit({
        sessionID: session.id,
        model,
        delegation: false,
        system: "INTERNAL_SYSTEM",
        parts: [{ type: "text", synthetic: true, text: "WORKER_RESULT" }],
      })
      expect(result.info.agent).toBe("fixture")
      const messages = await Session.messages({ sessionID: session.id })
      const wake = messages.find((message) => message.info.role === "user" && message.info.system === "INTERNAL_SYSTEM")
      expect(wake?.parts).toContainEqual(
        expect.objectContaining({ type: "text", synthetic: true, text: "WORKER_RESULT" }),
      )
      expect(
        local.requests.some((text) => text.includes("CUSTOM_AGENT_SYSTEM") && text.includes("INTERNAL_SYSTEM")),
      ).toBe(true)
      await SessionPrompt.command({
        sessionID: session.id,
        command: "fixture",
        arguments: "test",
        model: `${model.providerID}/${model.modelID}`,
        delegation: false,
      })
      expect(await RuntimeRuns.list(session.id)).toHaveLength(2)
      expect(local.requests.some((text) => text.includes("COMMAND_INPUT test"))).toBe(true)
    },
  })
}, 20_000)

for (const cancel of [false, true]) {
  test(`text-only settlement ${cancel ? "does not restart an accepted guide after cancellation" : "drains a guide accepted after the loop released its controller"}`, async () => {
    using local = provider()
    await using tmp = await tmpdir({ git: true, config: local.config })
    await Instance.provide({
      directory: tmp.path,
      init,
      async fn() {
        const session = await Session.create({ title: "Guide settlement fixture" })
        const entered = Promise.withResolvers<RuntimeRuns.Run>()
        const release = Promise.withResolvers<void>()
        let settlements = 0
        using hooks = RuntimeRuns.testing({
          async beforeSettle(run) {
            if (run.sessionID !== session.id || settlements++ !== 0) return
            entered.resolve(run)
            await release.promise
          },
        })
        const pending = SessionPrompt.submit({
          sessionID: session.id,
          model,
          delegation: false,
          parts: [{ type: "text", text: "FIRST_INPUT" }],
        })
        void pending.catch(() => undefined)
        try {
          const run = await entered.promise
          expect(SessionPrompt.activeController(session.id)).toBeUndefined()
          const before = local.requests.length
          const guide = {
            sessionID: session.id,
            model,
            effort: "normal" as const,
            delegation: false,
            requestID: "late-guide",
            message: "LATE_GUIDE",
          }
          expect((await RuntimeRuns.prompt(guide)).runID).toBe(run.runID)
          if (cancel) await RuntimeRuns.cancel(session.id, run.runID)
          release.resolve()
          const result = await pending
          expect((await RuntimeRuns.get(session.id, run.runID)).state).toBe(cancel ? "cancelled" : "completed")
          if (cancel) expect(local.requests).toHaveLength(before)
          else
            expect(result.parts.some((part) => part.type === "text" && part.text.includes("GUIDE_APPLIED"))).toBe(true)
          const calls = local.requests.length
          expect((await RuntimeRuns.prompt(guide)).runID).toBe(run.runID)
          expect(local.requests).toHaveLength(calls)
          const events = (await RuntimeEvents.replay(session.id)).events
          expect(events.filter((event) => event.type === "runtime.accepted")).toHaveLength(1)
          expect(events.at(-1)?.type).toBe(cancel ? "runtime.cancelled" : "runtime.completed")
        } finally {
          release.resolve()
          await pending.catch(() => undefined)
        }
      },
    })
  }, 20_000)
}
