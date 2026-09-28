import { expect, test } from "bun:test"
import { CustomConnections } from "../../src/provider/custom-connections"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"

test("custom Messages research harness preserves task, tool results and follow-up with adaptive xhigh", async () => {
  const captured: Record<string, unknown>[] = []
  const task = "使用现有环境完成公开数据的 R 语言差异表达分析，记录任务计划。CONTEXT_3927"
  const followup = "继续并保留数据来源与样本范围。FOLLOWUP_5182"
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.json()
      const research = body.tools?.length > 0
      if (research) captured.push(body)
      const tool = research && captured.length === 1
      const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
      const content = tool
        ? event("content_block_start", {
            index: 0,
            content_block: { type: "tool_use", id: "call_todo", name: "todowrite", input: {} },
          }) +
          event("content_block_delta", {
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify({
                todos: [{ id: "inspect", content: "Inspect public data", status: "completed", priority: "medium" }],
              }),
            },
          })
        : event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "CONTEXT_3927" } })
      return new Response(
        event("message_start", {
          message: {
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: "gpt-5.6-sol",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 0 },
          },
        }) +
          content +
          event("content_block_stop", { index: 0 }) +
          event("message_delta", {
            delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: 20 },
          }) +
          event("message_stop", {}),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const connection = await CustomConnections.save({
    name: "Messages harness",
    url: server.url.href,
    key: "fixture",
    protocol: "anthropic-messages",
    thinking: "adaptive",
    models: ["gpt-5.6-sol"],
  })
  try {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: () => trustProject(),
      fn: async () => {
        const session = await Session.create({ title: "Messages context" })
        const prompt = (text: string) =>
          SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: connection.id, modelID: "gpt-5.6-sol" },
            variant: "xhigh",
            agent: "research",
            delegation: false,
            parts: [{ type: "text", text }],
          })
        await prompt(task)
        expect(captured).toHaveLength(2)
        expect(JSON.stringify(captured[1].messages)).toContain("tool_result")
        expect(JSON.stringify(captured[1].messages)).toContain("Updated: 1/1 done")
        await prompt(followup)
        expect(captured).toHaveLength(3)
        for (const request of captured) {
          expect(request).toMatchObject({
            thinking: { type: "adaptive" },
            output_config: { effort: "xhigh" },
            stream: true,
          })
          expect(JSON.stringify(request.messages)).toContain(task)
          expect(request).not.toHaveProperty("reasoning_effort")
        }
        expect(JSON.stringify(captured[2].messages)).toContain(followup)
        const messages = await Session.messages({ sessionID: session.id })
        expect(
          messages
            .flatMap((item) => item.parts)
            .some((part) => part.type === "tool" && part.tool === "todowrite" && part.state.status === "completed"),
        ).toBe(true)
      },
    })
  } finally {
    await CustomConnections.remove(connection.id)
    server.stop(true)
  }
}, 30000)
