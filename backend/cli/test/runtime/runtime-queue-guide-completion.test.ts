import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { RuntimeEvents } from "../../src/runtime/events"
import { RuntimeQueue } from "../../src/runtime/queue"
import { RuntimeRuns } from "../../src/runtime/runs"
import { Session } from "../../src/session"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

test.each(["afterGuideMessage", "beforeGuideCommit"] as const)(
  "%s completion cannot strand the remaining queue while guidance is being committed",
  async (gap) => {
    let requests = 0
    using provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        await request.json()
        requests++
        const chunk = (content: string, finish: string | null) =>
          `data: ${JSON.stringify({ id: "chatcmpl-guide-completion", object: "chat.completion.chunk", created: 1, model: STRESS_PROVIDER_MODEL, choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`
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
        const session = await Session.create({ title: "Guidance completion race" })
        const input = {
          sessionID: session.id,
          effort: "normal" as const,
          delegation: false,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
        }
        const active = await RuntimeRuns.admit({ ...input, requestID: "active", message: "CURRENT" })
        await RuntimeQueue.enqueue({ ...input, requestID: "guidance", message: "GUIDANCE" })
        const queued = await RuntimeQueue.enqueue({ ...input, requestID: "next", message: "NEXT" })
        const guided = queued.items[0]!
        let completions = 0
        const finish = async () => {
          completions++
          // 模拟引导仍持有队列 claim 时，原运行已经完成并发出唯一一次 settled 通知。
          // 直接写终态，不重入当前 Guide 持有的 admission 锁。
          await RuntimeEvents.finish({
            sessionID: session.id,
            runID: active.run.runID,
            messageID: Identifier.ascending("message"),
          })
          await RuntimeQueue.settled(session.id, await RuntimeRuns.get(session.id, active.run.runID))
          expect(await RuntimeQueue.get(session.id)).toMatchObject({
            dispatching: guided.id,
            paused: false,
            items: [{ id: guided.id }, { id: queued.items[1]!.id }],
          })
        }
        try {
          {
            using interleave = RuntimeRuns.testing({ [gap]: finish })
            const promotion = RuntimeQueue.mutate({
              sessionID: session.id,
              revision: queued.revision,
              change: { type: "guide", id: guided.id, runID: active.run.runID },
            })
            if (gap === "beforeGuideCommit") await expect(promotion).rejects.toBeInstanceOf(RuntimeQueue.ConflictError)
            else expect((await promotion).dispatching).toBeUndefined()
          }
          const count = gap === "afterGuideMessage" ? 2 : 3
          const deadline = Date.now() + 8000
          let runs = await RuntimeRuns.list(session.id)
          while (Date.now() < deadline && (runs.length !== count || runs.some((run) => run.state !== "completed"))) {
            await Bun.sleep(25)
            runs = await RuntimeRuns.list(session.id)
          }
          // 无新 enqueue、resume 或浏览器轮询触发器，队列必须自行提交并完成后续任务。
          expect(runs.map((run) => run.state)).toEqual(Array(count).fill("completed"))
          // 后台标题等辅助请求也会使用此 provider；真正的任务次数由持久 run 回执判定。
          expect(requests).toBeGreaterThanOrEqual(count - 1)
          expect(completions).toBe(1)
          expect(await RuntimeQueue.get(session.id)).toMatchObject({ paused: false, items: [] })
          const messages = (await Session.messages({ sessionID: session.id })).filter(
            (message) => message.info.role === "user",
          )
          expect(
            messages.map((message) =>
              message.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])).join(""),
            ),
          ).toEqual(["GUIDANCE", "NEXT"])
        } finally {
          for (const run of await RuntimeRuns.list(session.id)) {
            if (run.state === "accepted" || run.state === "running") await RuntimeRuns.cancel(session.id, run.runID)
          }
        }
      },
    })
  },
  15_000,
)
