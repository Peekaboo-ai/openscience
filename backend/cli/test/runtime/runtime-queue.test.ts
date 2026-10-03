import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { RuntimeQueue } from "../../src/runtime/queue"
import { RuntimeRuns } from "../../src/runtime/runs"
import { RuntimeRoutes } from "../../src/server/routes/runtime"
import { Provider } from "../../src/provider/provider"
import { SessionPrompt } from "../../src/session/prompt"
import { Storage } from "../../src/storage/storage"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

test("queue persists rich requests, deduplicates retries, and rejects stale edits", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await RuntimeQueue.mutate({ sessionID: session.id, revision: 0, change: { type: "pause" } })
      const input = {
        sessionID: session.id,
        requestID: "rich",
        effort: "normal" as const,
        variant: "high",
        parts: [
          { type: "text" as const, text: "first" },
          { type: "file" as const, mime: "text/plain", filename: "data.txt", url: "data:text/plain;base64,MTIz" },
        ],
      }
      const results = await Promise.all(Array.from({ length: 4 }, () => RuntimeQueue.enqueue(input)))
      expect(results.every((result) => result.items.length === 1)).toBe(true)
      let state = await RuntimeQueue.enqueue({
        ...input,
        requestID: "second",
        parts: [{ type: "text", text: "second" }],
      })
      const first = state.items[0]!
      state = await RuntimeQueue.mutate({
        sessionID: session.id,
        revision: state.revision,
        change: { type: "edit", id: first.id, text: "edited" },
      })
      expect(state.items[0]!.input.parts?.[1]).toEqual(input.parts[1])
      expect(state.items[0]!.input.variant).toBe("high")
      await expect(
        RuntimeQueue.mutate({
          sessionID: session.id,
          revision: state.revision - 1,
          change: { type: "remove", id: first.id },
        }),
      ).rejects.toBeInstanceOf(RuntimeQueue.ConflictError)
      state = await RuntimeQueue.mutate({
        sessionID: session.id,
        revision: state.revision,
        change: { type: "move", id: first.id, before: null },
      })
      expect(state.items[1]!.id).toBe(first.id)
      state = await RuntimeQueue.mutate({
        sessionID: session.id,
        revision: state.revision,
        change: { type: "remove", id: first.id },
      })
      expect((await RuntimeQueue.enqueue(input)).items).toHaveLength(1)
      await expect(RuntimeQueue.enqueue({ ...input, variant: "low" })).rejects.toBeInstanceOf(
        RuntimeQueue.ConflictError,
      )
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
    },
  })
})

test("the server drains tasks in order without a browser, keeping queued messages out of the active turn", async () => {
  const arrived = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let hold = true
  using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.json()
      if (hold) {
        hold = false
        arrived.resolve()
        await release.promise
      }
      const chunk = (content: string, finish: string | null) =>
        `data: ${JSON.stringify({ id: "chatcmpl-queue", object: "chat.completion.chunk", created: 1, model: STRESS_PROVIDER_MODEL, choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`
      return new Response(chunk("Task completed.", null) + chunk("", "stop") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${provider.url.origin}/v1`) })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      const session = await Session.create({ title: "Queue behavior" })
      const input = {
        sessionID: session.id,
        effort: "normal" as const,
        delegation: false,
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
      }
      try {
        await RuntimeRuns.prompt({ ...input, requestID: "first", message: "FIRST" })
        await Promise.race([
          arrived.promise,
          Bun.sleep(10_000).then(() => {
            throw new Error("Provider did not receive initial run")
          }),
        ])
        const queued = await RuntimeQueue.enqueue({ ...input, requestID: "second", message: "SECOND" })
        expect(queued.items).toHaveLength(1)
        expect(
          (await Session.messages({ sessionID: session.id })).filter((message) => message.info.role === "user"),
        ).toHaveLength(1)
        release.resolve()
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const runs = await RuntimeRuns.list(session.id)
          if (runs.length === 2 && runs.every((run) => run.state === "completed")) break
          await Bun.sleep(25)
        }
        expect((await RuntimeRuns.list(session.id)).map((run) => run.state)).toEqual(["completed", "completed"])
        expect((await RuntimeQueue.get(session.id)).items).toHaveLength(0)
        const messages = (await Session.messages({ sessionID: session.id })).filter(
          (message) => message.info.role === "user",
        )
        expect(
          messages.map((message) =>
            message.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
          ),
        ).toEqual(["FIRST", "SECOND"])
      } finally {
        release.resolve()
      }
    },
  })
}, 30_000)

test("a failed or cancelled run pauses later queued work", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const active = await RuntimeRuns.admit({ sessionID: session.id, message: "active", effort: "normal" })
      await RuntimeQueue.enqueue({ sessionID: session.id, requestID: "next", message: "next", effort: "normal" })
      const run = await RuntimeRuns.cancel(session.id, active.run.runID)
      await RuntimeQueue.settled(session.id, run)
      expect(await RuntimeQueue.get(session.id)).toMatchObject({ paused: true, reason: "cancelled" })
      expect((await RuntimeQueue.get(session.id)).items).toHaveLength(1)
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
    },
  })
})

test("guidance is accepted during the initial prompt reservation without starting another run", async () => {
  await using tmp = await tmpdir({ git: true, config: stressProviderConfig("http://127.0.0.1:9/v1") })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      const session = await Session.create({})
      const input = {
        sessionID: session.id,
        effort: "normal" as const,
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
      }
      const first = await RuntimeRuns.admit({ ...input, message: "first" })
      const release = Promise.withResolvers<void>()
      const preparing = SessionPrompt.withCancellation(session.id, () => release.promise)
      try {
        const joined = await RuntimeRuns.admit({
          ...input,
          requestID: "guide",
          message: "use the existing Conda environment",
        })
        expect(joined.run.runID).toBe(first.run.runID)
        expect(joined.replayed).toBe(true)
        expect(
          (await Session.messages({ sessionID: session.id })).filter((message) => message.info.role === "user"),
        ).toHaveLength(1)
      } finally {
        release.resolve()
        await preparing
        await RuntimeRuns.cancel(session.id, first.run.runID)
      }
    },
  })
})

test("retrying cancellation of an old run does not pause its successor queue", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const input = { sessionID: session.id, effort: "normal" as const }
      const first = await RuntimeRuns.admit({ ...input, message: "first" })
      await RuntimeRuns.cancel(session.id, first.run.runID)
      const second = await RuntimeRuns.admit({ ...input, message: "second" })
      await RuntimeQueue.enqueue({ ...input, requestID: "third", message: "third" })
      try {
        const response = await RuntimeRoutes().request("http://localhost/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: session.id, runID: first.run.runID }),
        })
        expect(response.status).toBe(200)
        expect(await RuntimeQueue.get(session.id)).toMatchObject({
          paused: false,
          items: [{ input: { message: "third" } }],
        })
        expect((await RuntimeRuns.get(session.id, second.run.runID)).state).toBe("accepted")
      } finally {
        await RuntimeRuns.cancel(session.id, second.run.runID)
      }
    },
  })
})

test("restart preserves queued inputs but requires explicit resume", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await RuntimeQueue.mutate({ sessionID: session.id, revision: 0, change: { type: "pause" } })
      await RuntimeQueue.enqueue({
        sessionID: session.id,
        requestID: "restart",
        message: "preserve me",
        effort: "normal",
      })
      const keys = await Storage.list(["runtime_queue", Instance.project.id])
      await Storage.update<{ paused: boolean; owner: { pid: number; identity: string } }>(keys[0]!, (value) => {
        value.paused = false
        value.owner.identity = "dead-owner"
      })
      expect(await RuntimeQueue.get(session.id)).toMatchObject({
        paused: true,
        reason: "runtime_restarted",
        items: [{ input: { message: "preserve me" } }],
      })
      expect(await RuntimeRuns.list(session.id)).toHaveLength(0)
    },
  })
})

test("late settlement of an old run does not pause the successor queue", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const input = { sessionID: session.id, effort: "normal" as const }
      const first = await RuntimeRuns.admit({ ...input, message: "first" })
      const cancelled = await RuntimeRuns.cancel(session.id, first.run.runID)
      const second = await RuntimeRuns.admit({ ...input, message: "second" })
      await RuntimeQueue.enqueue({ ...input, requestID: "third", message: "third" })
      try {
        await RuntimeQueue.settled(session.id, cancelled)
        expect(await RuntimeQueue.get(session.id)).toMatchObject({
          paused: false,
          items: [{ input: { message: "third" } }],
        })
        expect((await RuntimeRuns.get(session.id, second.run.runID)).state).toBe("accepted")
        const stopped = await RuntimeRuns.cancel(session.id, second.run.runID)
        await RuntimeQueue.settled(session.id, stopped)
        expect(await RuntimeQueue.get(session.id)).toMatchObject({ paused: true, reason: "cancelled" })
      } finally {
        await RuntimeRuns.cancel(session.id, second.run.runID)
      }
    },
  })
})
