import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { RuntimeQueue } from "../../src/runtime/queue"
import { RuntimeRuns } from "../../src/runtime/runs"
import { RuntimeEvents } from "../../src/runtime/events"
import { MessageV2 } from "../../src/session/message-v2"
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
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
        tier: "priority",
        context: 16_000,
        delegation: false,
        parts: [
          { type: "text" as const, text: "first" },
          { type: "file" as const, mime: "text/plain", filename: "data.txt", url: "data:text/plain;base64,MTIz" },
          { type: "text" as const, text: "additional instructions" },
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
      expect(state.items[0]!.input.parts).toEqual([{ type: "text", text: "edited" }, ...input.parts.slice(1)])
      expect(state.items[0]!.input.variant).toBe("high")
      expect(state.items[0]!.input).toMatchObject({
        model: input.model,
        tier: "priority",
        context: 16_000,
        delegation: false,
        effort: "normal",
      })
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

test("a queued prompt can guide the exact active run once while keeping other tasks and their settings queued", async () => {
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
      const active = await RuntimeRuns.admit({ ...input, message: "current task" })
      try {
        await RuntimeQueue.mutate({ sessionID: session.id, revision: 0, change: { type: "pause" } })
        await RuntimeQueue.enqueue({ ...input, requestID: "next", message: "next task" })
        const queued = await RuntimeQueue.enqueue({
          ...input,
          requestID: "guidance",
          effort: "ultra",
          variant: "high",
          parts: [
            { type: "text", text: "Use the provided sample" },
            { type: "file", mime: "image/png", filename: "sample.png", url: "data:image/png;base64,aGVsbG8=" },
          ],
        })
        const item = queued.items[1]!
        const mutation = {
          sessionID: session.id,
          revision: queued.revision,
          change: { type: "guide" as const, id: item.id, runID: active.run.runID },
        }
        const results = await Promise.all(Array.from({ length: 4 }, () => RuntimeQueue.mutate(mutation)))
        expect(results.every((result) => result.items.length === 1 && result.paused)).toBe(true)
        expect(results[0]!.items[0]!.input.message).toBe("next task")
        expect(results[0]!.dispatching).toBeUndefined()
        const messages = (await Session.messages({ sessionID: session.id })).filter(
          (entry) => entry.info.role === "user",
        )
        expect(messages).toHaveLength(1)
        expect(messages[0]!.info).toMatchObject({ model: input.model, variant: "high", effort: "ultra" })
        expect(messages[0]!.parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "Use the provided sample" }),
            expect.objectContaining({ type: "file", filename: "sample.png" }),
          ]),
        )
        expect(await RuntimeRuns.list(session.id)).toHaveLength(1)
        expect((await RuntimeRuns.get(session.id, active.run.runID)).state).toBe("accepted")
        await RuntimeRuns.cancel(session.id, active.run.runID)
        // 响应丢失后，即使队列已有新版本，也必须安全复用原引导回执。
        const current = await RuntimeQueue.get(session.id)
        await RuntimeQueue.mutate({
          sessionID: session.id,
          revision: current.revision,
          change: { type: "remove", id: current.items[0]!.id },
        })
        expect((await RuntimeQueue.mutate(mutation)).items).toHaveLength(0)
        expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
      } finally {
        await RuntimeRuns.cancel(session.id, active.run.runID)
      }
    },
  })
})

test("guidance attachment permission waits leave the queue responsive and retire with their exact run", async () => {
  await using tmp = await tmpdir({ git: true, config: stressProviderConfig("http://127.0.0.1:9/v1") })
  await using outside = await tmpdir()
  const attachment = path.join(outside.path, "notes.txt")
  await Bun.write(attachment, "Outside project research notes")
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      for (const ending of ["cancel", "complete", "reject"] as const) {
        const session = await Session.create({})
        const input = {
          sessionID: session.id,
          effort: "normal" as const,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
        }
        const active = await RuntimeRuns.admit({ ...input, requestID: "active", message: "active" })
        await RuntimeQueue.mutate({ sessionID: session.id, revision: 0, change: { type: "pause" } })
        const queue = await RuntimeQueue.enqueue({
          ...input,
          requestID: "attachment",
          parts: [
            { type: "text", text: "Use the attached notes" },
            { type: "file", url: pathToFileURL(attachment).href, filename: "notes.txt", mime: "text/plain" },
          ],
        })
        const pending = RuntimeQueue.mutate({
          sessionID: session.id,
          revision: queue.revision,
          change: { type: "guide", id: queue.items[0]!.id, runID: active.run.runID },
        }).then(
          () => undefined,
          (error: unknown) => error,
        )
        try {
          const deadline = Date.now() + 5_000
          while (!(await PermissionNext.list()).some((request) => request.sessionID === session.id)) {
            if (Date.now() > deadline) throw new Error("The attachment permission did not appear")
            const failure = await Promise.race([pending, Bun.sleep(10)])
            if (failure) throw failure
          }
          const start = Date.now()
          const observed = await RuntimeQueue.get(session.id)
          expect(observed.dispatching).toBe(queue.items[0]!.id)
          const added = await RuntimeQueue.enqueue({ ...input, requestID: "next", message: "next" })
          await RuntimeQueue.mutate({
            sessionID: session.id,
            revision: added.revision,
            change: { type: "edit", id: added.items[1]!.id, text: "edited while waiting" },
          })
          expect(Date.now() - start).toBeLessThan(2_000)
          if (ending === "cancel") {
            const response = await RuntimeRoutes().request("/cancel", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionID: session.id, runID: active.run.runID }),
            })
            expect(response.status).toBe(200)
          } else if (ending === "complete") {
            await RuntimeEvents.finish({
              sessionID: session.id,
              runID: active.run.runID,
              messageID: active.run.messageID,
            })
          } else {
            const permission = (await PermissionNext.list()).find((request) => request.sessionID === session.id)!
            await PermissionNext.reply({ requestID: permission.id, reply: "reject" })
          }
          expect(await pending).toBeInstanceOf(
            ending === "reject" ? RuntimeRuns.PreparationError : RuntimeQueue.ConflictError,
          )
          expect((await PermissionNext.list()).filter((request) => request.sessionID === session.id)).toHaveLength(0)
          const remaining = await RuntimeQueue.get(session.id)
          expect(remaining.dispatching).toBeUndefined()
          expect(remaining.paused).toBe(true)
          expect(remaining.items).toHaveLength(2)
          expect(remaining.items[1]!.input.message).toBe("edited while waiting")
          expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
          if (ending === "reject") {
            expect((await RuntimeRuns.get(session.id, active.run.runID)).state).toBe("accepted")
            const edited = await RuntimeQueue.mutate({
              sessionID: session.id,
              revision: remaining.revision,
              change: { type: "edit", id: remaining.items[0]!.id, text: "revised after rejection" },
            })
            const removed = await RuntimeQueue.mutate({
              sessionID: session.id,
              revision: edited.revision,
              change: { type: "remove", id: edited.items[0]!.id },
            })
            expect(removed.items).toHaveLength(1)
            continue
          }
          const replacement = await RuntimeRuns.admit({ ...input, requestID: "replacement", message: "replacement" })
          await RuntimeRuns.cancel(session.id, active.run.runID)
          expect((await RuntimeRuns.get(session.id, replacement.run.runID)).state).toBe("accepted")
          await RuntimeRuns.cancel(session.id, replacement.run.runID)
        } finally {
          await RuntimeRuns.cancel(session.id, active.run.runID)
          await pending
        }
      }
    },
  })
}, 30_000)

test("guiding a finished or replaced run conflicts and leaves the queued prompt editable", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const input = { sessionID: session.id, effort: "normal" as const }
      const first = await RuntimeRuns.admit({ ...input, message: "old task" })
      const queue = await RuntimeQueue.enqueue({ ...input, requestID: "queued", message: "guide me" })
      expect(queue.activeRunID).toBe(first.run.runID)
      const keys = await Storage.list(["runtime_queue", Instance.project.id])
      expect(await Storage.read(keys[0]!)).not.toHaveProperty("activeRunID")
      await RuntimeRuns.cancel(session.id, first.run.runID)
      for (const replacing of [false, true]) {
        const successor = replacing ? await RuntimeRuns.admit({ ...input, message: "new task" }) : undefined
        try {
          const current = await RuntimeQueue.get(session.id)
          expect(current.activeRunID).toBe(successor?.run.runID)
          const response = await RuntimeRoutes().request("http://localhost/queue", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionID: session.id,
              revision: current.revision,
              change: { type: "guide", id: queue.items[0]!.id, runID: first.run.runID },
            }),
          })
          expect(response.status).toBe(409)
          const retained = await RuntimeQueue.get(session.id)
          expect(retained.items).toHaveLength(1)
          expect(retained.dispatching).toBeUndefined()
          const edited = await RuntimeQueue.mutate({
            sessionID: session.id,
            revision: retained.revision,
            change: { type: "edit", id: retained.items[0]!.id, text: "updated" },
          })
          expect(edited.items[0]!.input.message).toBe("updated")
          expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
          if (successor) expect((await RuntimeRuns.get(session.id, successor.run.runID)).state).toBe("accepted")
        } finally {
          if (successor) await RuntimeRuns.cancel(session.id, successor.run.runID)
        }
      }
      expect(await RuntimeRuns.list(session.id)).toHaveLength(2)
    },
  })
})

test("recovery reconciles accepted guidance and cannot overwrite its in-flight queue claim", async () => {
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
      const active = await RuntimeRuns.admit({ ...input, message: "active" })
      try {
        await RuntimeQueue.mutate({ sessionID: session.id, revision: 0, change: { type: "pause" } })
        await RuntimeQueue.enqueue({ ...input, requestID: "guide", message: "guidance" })
        const queued = await RuntimeQueue.enqueue({ ...input, requestID: "next", message: "next task" })
        const first = queued.items[0]!
        const second = queued.items[1]!
        const keys = await Storage.list(["runtime_queue", Instance.project.id])
        // 模拟先持久化意图并完成接收、再在删除队列条目和写回执前中断的边界。
        await Storage.update<{ dispatching?: string; guiding?: { id: string; runID: string } }>(keys[0]!, (state) => {
          state.dispatching = first.id
          state.guiding = { id: first.id, runID: active.run.runID }
        })
        await expect(
          RuntimeQueue.mutate({
            sessionID: session.id,
            revision: queued.revision,
            change: { type: "guide", id: second.id, runID: active.run.runID },
          }),
        ).rejects.toBeInstanceOf(RuntimeQueue.ConflictError)
        await expect(
          RuntimeQueue.mutate({
            sessionID: session.id,
            revision: queued.revision,
            change: { type: "remove", id: first.id },
          }),
        ).rejects.toBeInstanceOf(RuntimeQueue.ConflictError)
        await RuntimeRuns.guide({ ...first.input, requestID: `queue:${first.id}` }, active.run.runID)
        await expect(
          RuntimeRuns.guide(
            { ...first.input, requestID: `queue:${first.id}`, message: "different guidance" },
            active.run.runID,
          ),
        ).rejects.toBeInstanceOf(RuntimeRuns.ConflictError)
        await expect(
          RuntimeRuns.guide({ ...first.input, requestID: `queue:${first.id}` }, "run_different"),
        ).rejects.toBeInstanceOf(RuntimeRuns.ConflictError)
        await RuntimeRuns.cancel(session.id, active.run.runID)
        await Storage.update<{ owner: { identity: string } }>(keys[0]!, (state) => {
          state.owner.identity = "dead-owner"
        })
        const recovered = await RuntimeQueue.get(session.id)
        expect(recovered).toMatchObject({ paused: true, reason: "runtime_restarted", dispatching: first.id })
        const resumed = await RuntimeQueue.mutate({
          sessionID: session.id,
          revision: recovered.revision,
          change: { type: "resume" },
        })
        expect(resumed).toMatchObject({ paused: true, reason: "cancelled", items: [{ id: second.id }] })
        expect(resumed.dispatching).toBeUndefined()
        expect(await Session.messages({ sessionID: session.id })).toHaveLength(1)
        expect(await RuntimeRuns.list(session.id)).toHaveLength(1)
      } finally {
        await RuntimeRuns.cancel(session.id, active.run.runID)
      }
    },
  })
})

test("a newer directly admitted run inherits a completed queue barrier", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const input = { sessionID: session.id, effort: "normal" as const }
      const first = await RuntimeRuns.admit({ ...input, message: "first" })
      await RuntimeQueue.enqueue({ ...input, requestID: "queued", message: "queued" })
      await RuntimeEvents.finish({ sessionID: session.id, runID: first.run.runID, messageID: "msg_finished" })
      const second = await RuntimeRuns.admit({ ...input, message: "direct successor" })
      await RuntimeQueue.settled(session.id, await RuntimeRuns.get(session.id, first.run.runID))
      const keys = await Storage.list(["runtime_queue", Instance.project.id])
      expect(await Storage.read(keys[0]!)).toMatchObject({ barrier: second.run.runID })
      const cancelled = await RuntimeRuns.cancel(session.id, second.run.runID)
      await RuntimeQueue.settled(session.id, cancelled)
      expect(await RuntimeQueue.get(session.id)).toMatchObject({
        paused: true,
        reason: "cancelled",
        items: [{ input: { message: "queued" } }],
      })
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
    },
  })
})

test("a direct prompt winning the final queue admission race becomes its durable barrier", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const winner: { run?: RuntimeRuns.Run } = {}
      using race = RuntimeRuns.testing({
        beforeAdmission: async (input) => {
          if (!input.requestID?.startsWith("queue:") || winner.run) return
          winner.run = (
            await RuntimeRuns.admit({
              sessionID: session.id,
              requestID: "direct",
              message: "direct winner",
              effort: "normal",
            })
          ).run
        },
      })
      try {
        const queued = await RuntimeQueue.enqueue({
          sessionID: session.id,
          requestID: "queued",
          message: "waiting",
          effort: "normal",
        })
        expect(winner.run).toBeDefined()
        expect(queued).toMatchObject({
          paused: false,
          activeRunID: winner.run!.runID,
          items: [{ input: { message: "waiting" } }],
        })
        const keys = await Storage.list(["runtime_queue", Instance.project.id])
        expect(await Storage.read(keys[0]!)).toMatchObject({ barrier: winner.run!.runID })
        const cancelled = await RuntimeRuns.cancel(session.id, winner.run!.runID)
        await RuntimeQueue.settled(session.id, cancelled)
        expect(await RuntimeQueue.get(session.id)).toMatchObject({ paused: true, reason: "cancelled" })
        expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
      } finally {
        if (winner.run) await RuntimeRuns.cancel(session.id, winner.run.runID)
      }
    },
  })
})

test("a legacy controller without a runtime receipt visibly pauses queued work for explicit resume", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const release = Promise.withResolvers<void>()
      const running = SessionPrompt.withCancellation(session.id, () => release.promise)
      try {
        const queue = await RuntimeQueue.enqueue({
          sessionID: session.id,
          requestID: "legacy-busy",
          message: "next",
          effort: "normal",
        })
        expect(queue).toMatchObject({ paused: true, reason: "session_busy", items: [{ input: { message: "next" } }] })
        expect(queue.activeRunID).toBeUndefined()
      } finally {
        release.resolve()
        await running
      }
      expect(await RuntimeQueue.get(session.id)).toMatchObject({ paused: true, reason: "session_busy" })
      expect(await RuntimeRuns.list(session.id)).toHaveLength(0)
    },
  })
})

test("guidance retries recover normalized message and attachment IDs across both receipt gaps", async () => {
  await using tmp = await tmpdir({ git: true, config: stressProviderConfig("http://127.0.0.1:9/v1") })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      for (const gap of ["prepared", "partial", "message"] as const) {
        const session = await Session.create({})
        const input = {
          sessionID: session.id,
          effort: "normal" as const,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
        }
        const active = await RuntimeRuns.admit({ ...input, message: "active" })
        try {
          const queue = await RuntimeQueue.enqueue({
            ...input,
            requestID: gap,
            messageID: "msg_000000000001AAAAAAAAAAAAAA",
            parts: [
              { type: "text", text: "guidance" },
              { type: "file", mime: "image/png", filename: "sample.png", url: "data:image/png;base64,aGVsbG8=" },
            ],
          })
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: input.model,
            noReply: true,
            parts: [{ type: "text", text: "existing transcript" }],
          })
          let retained: MessageV2.WithParts | undefined
          const fail = async (message: MessageV2.WithParts) => {
            retained = message
            if (gap === "partial") await Session.updateMessage(message.info)
            throw new Error("Interrupted before runtime receipt")
          }
          {
            using fault = RuntimeRuns.testing(
              gap === "message" ? { afterGuideMessage: fail } : { afterGuidePrepared: fail },
            )
            await expect(
              RuntimeQueue.mutate({
                sessionID: session.id,
                revision: queue.revision,
                change: { type: "guide", id: queue.items[0]!.id, runID: active.run.runID },
              }),
            ).rejects.toThrow("Interrupted before runtime receipt")
          }
          expect(retained).toBeDefined()
          expect(retained!.info.id).not.toBe(queue.items[0]!.input.messageID)
          const pending = await RuntimeQueue.get(session.id)
          expect(pending).toMatchObject({ paused: true, reason: "submission_failed", dispatching: queue.items[0]!.id })
          if (gap !== "prepared") await RuntimeRuns.cancel(session.id, active.run.runID)
          const resumed = await RuntimeQueue.mutate({
            sessionID: session.id,
            revision: pending.revision,
            change: { type: "resume" },
          })
          expect(resumed.items).toHaveLength(0)
          expect(resumed.dispatching).toBeUndefined()
          const messages = (await Session.messages({ sessionID: session.id })).filter(
            (entry) => entry.info.role === "user",
          )
          expect(messages).toHaveLength(2)
          expect(messages[1]!.info.id).toBe(retained!.info.id)
          expect(messages[1]!.parts.map((part) => part.id).sort()).toEqual(
            retained!.parts.map((part) => part.id).sort(),
          )
          expect(await RuntimeRuns.list(session.id)).toHaveLength(1)
        } finally {
          await RuntimeRuns.cancel(session.id, active.run.runID)
        }
      }
    },
  })
})

test("an expired uncommitted guidance preparation can be edited and promoted to a new run", async () => {
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
      const first = await RuntimeRuns.admit({ ...input, message: "first task" })
      const queued = await RuntimeQueue.enqueue({ ...input, requestID: "guidance", message: "old instruction" })
      {
        using fault = RuntimeRuns.testing({
          afterGuidePrepared: async () => {
            throw new Error("Interrupted preparation")
          },
        })
        await expect(
          RuntimeQueue.mutate({
            sessionID: session.id,
            revision: queued.revision,
            change: { type: "guide", id: queued.items[0]!.id, runID: first.run.runID },
          }),
        ).rejects.toThrow("Interrupted preparation")
      }
      await RuntimeRuns.cancel(session.id, first.run.runID)
      const pending = await RuntimeQueue.get(session.id)
      await expect(
        RuntimeQueue.mutate({ sessionID: session.id, revision: pending.revision, change: { type: "resume" } }),
      ).rejects.toBeInstanceOf(RuntimeQueue.ConflictError)
      expect(await Storage.list(["runtime_guidance", Instance.project.id])).toHaveLength(0)
      const retained = await RuntimeQueue.get(session.id)
      expect(retained.dispatching).toBeUndefined()
      const edited = await RuntimeQueue.mutate({
        sessionID: session.id,
        revision: retained.revision,
        change: { type: "edit", id: retained.items[0]!.id, text: "new instruction" },
      })
      const second = await RuntimeRuns.admit({ ...input, message: "second task" })
      try {
        const guided = await RuntimeQueue.mutate({
          sessionID: session.id,
          revision: edited.revision,
          change: { type: "guide", id: edited.items[0]!.id, runID: second.run.runID },
        })
        expect(guided.items).toHaveLength(0)
        const messages = await Session.messages({ sessionID: session.id })
        expect(messages).toHaveLength(1)
        expect(messages[0]!.parts).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "text", text: "new instruction" })]),
        )
        expect(await Storage.list(["runtime_guidance", Instance.project.id])).toHaveLength(0)
      } finally {
        await RuntimeRuns.cancel(session.id, second.run.runID)
      }
    },
  })
})

test("guiding a later queue item keeps transcript order correct when earlier items subsequently execute", async () => {
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
        `data: ${JSON.stringify({ id: "chatcmpl-guide-order", object: "chat.completion.chunk", created: 1, model: STRESS_PROVIDER_MODEL, choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`
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
      const session = await Session.create({})
      const input = {
        sessionID: session.id,
        effort: "normal" as const,
        delegation: false,
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
      }
      try {
        const active = await RuntimeRuns.prompt({ ...input, requestID: "first", message: "FIRST" })
        await Promise.race([
          arrived.promise,
          Bun.sleep(10_000).then(() => {
            throw new Error("Initial run did not reach provider")
          }),
        ])
        await RuntimeQueue.enqueue({ ...input, requestID: "a", message: "A" })
        const queue = await RuntimeQueue.enqueue({ ...input, requestID: "b", message: "B" })
        const guided = await RuntimeQueue.mutate({
          sessionID: session.id,
          revision: queue.revision,
          change: { type: "guide", id: queue.items[1]!.id, runID: active.runID },
        })
        expect(guided.items.map((item) => item.input.message)).toEqual(["A"])
        release.resolve()
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const runs = await RuntimeRuns.list(session.id)
          if (runs.length === 2 && runs.every((run) => run.state === "completed")) break
          await Bun.sleep(25)
        }
        expect((await RuntimeRuns.list(session.id)).map((run) => run.state)).toEqual(["completed", "completed"])
        const messages = (await Session.messages({ sessionID: session.id })).filter(
          (entry) => entry.info.role === "user",
        )
        expect(
          messages.map((entry) =>
            entry.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])).join(""),
          ),
        ).toEqual(["FIRST", "B", "A"])
        expect((await RuntimeQueue.get(session.id)).items).toHaveLength(0)
      } finally {
        release.resolve()
      }
    },
  })
}, 30_000)
