import { expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { CustomConnections } from "../../src/provider/custom-connections"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"

test("custom Responses research carries complete tool results and encrypted reasoning without server continuation references", async () => {
  const captured: {
    input: Record<string, unknown>[]
    store?: boolean
    previous_response_id?: string
    model: string
  }[] = []
  const task = "仅验收协议：记录一条待办，不执行科研分析。TASK_7341"
  const followup = "沿用已完成的结果，不再执行工具。FOLLOWUP_5218"
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.json()
      const research = body.tools?.length > 0
      if (research) captured.push(body)
      if (
        body.store !== false ||
        body.previous_response_id ||
        body.input.some((item: Record<string, unknown>) => item.id)
      ) {
        return Response.json(
          { error: { type: "invalid_request_error", message: "previous_response_id is not available for this user" } },
          { status: 400 },
        )
      }
      const first = research && captured.length === 1
      return Response.json({
        id: `resp_fixture_${captured.length}`,
        object: "response",
        created_at: 1,
        model: "gpt-6.1-sol",
        status: "completed",
        output: first
          ? [
              {
                type: "reasoning",
                id: "rs_fixture",
                summary: [{ type: "summary_text", text: "Record the requested diagnostic." }],
                encrypted_content: "fixture-encrypted-reasoning",
              },
              {
                type: "function_call",
                id: "fc_fixture",
                call_id: "call_todo",
                name: "todowrite",
                arguments: JSON.stringify({
                  todos: [{ id: "protocol", content: "Protocol diagnostic", status: "completed", priority: "low" }],
                }),
              },
            ]
          : [
              {
                type: "message",
                id: "msg_fixture",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "TASK_7341 FOLLOWUP_5218", annotations: [] }],
              },
            ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 10 },
        },
      })
    },
  })
  const connection = await CustomConnections.save({
    name: "Stateless Responses fixture",
    url: server.url.href,
    key: "fixture",
    protocol: "openai-responses",
    models: ["gpt-6.1-sol"],
  })
  try {
    const provider = (await Config.getGlobal()).provider![connection.id]
    await Config.setProvider(
      connection.id,
      { ...provider, options: { ...provider.options, streaming: false } },
      "global",
      { preserveInstances: true },
    )
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: () => trustProject(),
      fn: async () => {
        const session = await Session.create({ title: "Responses protocol fixture" })
        const prompt = (text: string) =>
          SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: connection.id, modelID: "gpt-6.1-sol" },
            variant: "xhigh",
            agent: "research",
            delegation: false,
            parts: [{ type: "text", text }],
          })
        await prompt(task)
        expect(captured).toHaveLength(2)
        expect(captured[1].input).toContainEqual({
          type: "function_call_output",
          call_id: "call_todo",
          output: expect.stringContaining("Updated: 1/1 done"),
        })
        expect(captured[1].input).toContainEqual(
          expect.objectContaining({ type: "reasoning", encrypted_content: "fixture-encrypted-reasoning" }),
        )
        await prompt(followup)
        expect(captured).toHaveLength(3)
        for (const body of captured) {
          expect(body.store).toBe(false)
          expect(body).not.toHaveProperty("previous_response_id")
          expect(body.input.every((item) => !Object.hasOwn(item, "id"))).toBe(true)
          expect(JSON.stringify(body.input)).toContain(task)
        }
        expect(JSON.stringify(captured[2].input)).toContain(followup)
        const messages = await Session.messages({ sessionID: session.id })
        expect(messages.every((message) => message.info.role !== "assistant" || !message.info.error)).toBe(true)
        const calls = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ callID: "call_todo", state: { status: "completed" } })
      },
    })
  } finally {
    await CustomConnections.remove(connection.id)
    server.stop(true)
  }
}, 30000)
