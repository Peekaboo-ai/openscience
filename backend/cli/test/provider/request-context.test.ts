import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"

for (const streaming of [true, false])
  test(`research harness preserves multilingual tasks and follow-ups (streaming=${streaming})`, async () => {
    const task =
      "使用现有虚拟环境完成 R 语言差异表达分析，生成火山图和热图并注明公开数据来源。Report ONELAB_CONTEXT_7284."
    const followup = "继续上述分析，保留数据来源和样本范围。Report ONELAB_FOLLOWUP_5931."
    const captured: {
      messages: { role: string; content: unknown }[]
      stream?: boolean
      reasoning_effort?: string
      tools?: unknown[]
    }[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = await request.json()
        if (body.tools?.length) captured.push(body)
        if (body.stream) {
          const chunk = (delta: unknown, finish: string | null) =>
            `data: ${JSON.stringify({
              id: "context",
              model: "gpt-5.6-sol",
              created: 1,
              choices: [{ index: 0, delta, finish_reason: finish }],
              ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } : {}),
            })}\n\n`
          return new Response(
            chunk({ role: "assistant", content: "ONELAB_CONTEXT_7284" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
            {
              headers: { "content-type": "text/event-stream" },
            },
          )
        }
        return Response.json({
          id: "context",
          model: "gpt-5.6-sol",
          created: 1,
          choices: [
            { index: 0, message: { role: "assistant", content: "ONELAB_CONTEXT_7284" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        })
      },
    })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          provider: {
            context: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: server.url.href + "v1", apiKey: "fixture", streaming },
              models: {
                "gpt-5.6-sol": {
                  reasoning: true,
                  tool_call: true,
                  limit: { context: 128000, output: 8192 },
                  variants: { xhigh: { reasoningEffort: "xhigh" } },
                },
              },
            },
          },
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          await trustProject()
          await Provider.invalidate()
        },
        fn: async () => {
          const session = await Session.create({ title: "context capture" })
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: "context", modelID: "gpt-5.6-sol" },
            variant: "xhigh",
            agent: "research",
            delegation: false,
            parts: [{ type: "text", text: task }],
          })
          expect(captured).toHaveLength(1)
          expect(captured[0].stream === true).toBe(streaming)
          expect(captured[0].reasoning_effort).toBe("xhigh")
          expect(
            captured[0].messages.filter((m) => m.role === "user").some((m) => JSON.stringify(m.content).includes(task)),
          ).toBe(true)
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: "context", modelID: "gpt-5.6-sol" },
            variant: "xhigh",
            agent: "research",
            delegation: false,
            parts: [{ type: "text", text: followup }],
          })
          expect(captured).toHaveLength(2)
          const users = captured[1].messages.filter((m) => m.role === "user")
          expect(users.some((m) => JSON.stringify(m.content).includes(task))).toBe(true)
          expect(users.some((m) => JSON.stringify(m.content).includes(followup))).toBe(true)
          expect(captured[1].reasoning_effort).toBe("xhigh")
        },
      })
    } finally {
      server.stop(true)
    }
  }, 30000)
