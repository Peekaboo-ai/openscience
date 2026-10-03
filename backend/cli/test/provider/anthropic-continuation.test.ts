import { describe, expect, test } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { generateText, jsonSchema, tool } from "ai"
import { normalizeAnthropicContinuation, retrySyntheticContinuation } from "../../src/provider/anthropic-continuation"

const message = "synthetic previous_response_id is unavailable or expired"
const failure = (text = message, status = 400) =>
  Response.json({ type: "error", error: { type: "invalid_request_error", message: text } }, { status })
const transcript = {
  model: "gateway-model",
  stream: true,
  max_tokens: 1024,
  thinking: { type: "adaptive" },
  output_config: { effort: "xhigh" },
  system: [{ type: "text", text: "Research assistant", cache_control: { type: "ephemeral" } }],
  tools: [{ name: "analyze", input_schema: { type: "object", properties: {} } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Analyze this dataset" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "expired-state" },
        { type: "redacted_thinking", data: "expired-redacted-state" },
        { type: "text", text: "Using the existing analysis." },
        { type: "tool_use", id: "call_old", name: "analyze", input: { file: "dataset.csv" } },
        { type: "tool_use", id: "call_second", name: "analyze", input: { file: "second.csv" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_old", content: "Saved results/report.html" },
        { type: "tool_result", tool_use_id: "call_second", content: [{ type: "text", text: "Already finished" }] },
        { type: "text", text: "Summarize the completed results." },
      ],
    },
  ],
}

describe("opt-in stateless custom Messages history", () => {
  test("replays the complete history on every request without changing stored records or inference settings", () => {
    const body = JSON.stringify(transcript)
    const first = JSON.parse(normalizeAnthropicContinuation(body, "stateless"))
    const second = JSON.parse(normalizeAnthropicContinuation(body, "stateless"))
    expect({ ...first, messages: undefined }).toEqual({ ...transcript, messages: undefined })
    expect(first.messages[0]).toEqual(transcript.messages[0])
    expect(first.messages[1].content).toHaveLength(3)
    expect(first.messages[1].content[0]).toEqual(transcript.messages[1].content[2])
    expect(first.messages[2].content[2]).toEqual(transcript.messages[2].content[2])
    for (const [index, call] of first.messages[1].content.slice(1).entries()) {
      expect(call.id).not.toBe(second.messages[1].content[index + 1].id)
      expect(first.messages[2].content[index].tool_use_id).toBe(call.id)
      expect(first.messages[2].content[index]).toEqual({
        ...transcript.messages[2].content[index],
        tool_use_id: call.id,
      })
    }
    expect(JSON.stringify(transcript)).toBe(body)
  })

  test.each([undefined, false, "auto", "unknown"])("preserves normal history for mode %s", (mode) => {
    const body = JSON.stringify(transcript)
    expect(normalizeAnthropicContinuation(body, mode)).toBe(body)
  })

  test.each(["claude-sonnet-4-6", "anthropic/claude-opus-4-7", "provider.claude-fable-5-1"])(
    "preserves native Claude signatures and tool identifiers for %s",
    (model) => {
      const body = JSON.stringify({ ...transcript, model })
      expect(normalizeAnthropicContinuation(body, "stateless")).toBe(body)
    },
  )

  test.each([
    "invalid JSON",
    JSON.stringify({ messages: transcript.messages }),
    JSON.stringify({ model: "gpt-6.1-sol", messages: [transcript.messages[0]] }),
  ])("preserves bodies without translated continuation state: %s", (body) =>
    expect(normalizeAnthropicContinuation(body, "stateless")).toBe(body),
  )
})

describe("expired custom Messages gateway continuation", () => {
  test("rebuilds only transient state while retaining completed tool results and request settings", async () => {
    const body = JSON.stringify(transcript)
    const sent: string[] = []
    const success = new Response("recovered")
    const response = await retrySyntheticContinuation({
      response: failure(),
      enabled: true,
      body,
      retry: async (value) => {
        sent.push(value)
        return success
      },
    })
    expect(response).toBe(success)
    expect(sent).toHaveLength(1)
    const replay = JSON.parse(sent[0])
    expect({ ...replay, messages: undefined }).toEqual({ ...transcript, messages: undefined })
    expect(replay.messages[0]).toEqual(transcript.messages[0])
    expect(replay.messages[1].content[0]).toEqual(transcript.messages[1].content[2])
    const calls = replay.messages[1].content.slice(1)
    const results = replay.messages[2].content.slice(0, 2)
    expect(new Set(calls.map((part: { id: string }) => part.id)).size).toBe(2)
    for (const [index, call] of calls.entries()) {
      expect(call.id).not.toBe(["call_old", "call_second"][index])
      expect(call.id).toMatch(/^call_[a-f0-9]{32}$/)
      expect({ ...call, id: undefined }).toEqual({ ...transcript.messages[1].content[index + 3], id: undefined })
      expect(results[index]).toEqual({ ...transcript.messages[2].content[index], tool_use_id: call.id })
    }
    expect(replay.messages[2].content[2]).toEqual(transcript.messages[2].content[2])
    expect(JSON.stringify(transcript)).toBe(body)
  })

  test.each([
    [
      "ordinary parameter error",
      failure("The request could not be processed. Please check the request parameters."),
      true,
    ],
    ["unrelated signature error", failure("Invalid thinking signature"), true],
    ["native connection", failure(), false],
    ["rate limiting", failure(message, 429), true],
    ["already started stream", failure(message, 200), true],
    ["malformed error", new Response("not JSON", { status: 400 }), true],
    ["oversized error", failure("x".repeat(20_000)), true],
  ])("preserves %s without dispatching another request", async (_, response, enabled) => {
    const original = await response.clone().text()
    let retries = 0
    const result = await retrySyntheticContinuation({
      response,
      enabled,
      body: JSON.stringify(transcript),
      retry: async () => {
        retries++
        return new Response("unexpected")
      },
    })
    expect(result).toBe(response)
    expect(retries).toBe(0)
    expect(await result.text()).toBe(original)
  })

  test("does not repeat recovery when the upstream rejects it", async () => {
    let retries = 0
    const rejected = failure()
    const result = await retrySyntheticContinuation({
      response: failure(),
      enabled: true,
      body: JSON.stringify(transcript),
      retry: async () => {
        retries++
        return rejected
      },
    })
    expect(retries).toBe(1)
    expect(result).toBe(rejected)
    expect(await result.json()).toMatchObject({ error: { message } })
  })

  test("rebuilds old tool references even when earlier thinking was already omitted", async () => {
    const body = structuredClone(transcript)
    body.messages[1].content = body.messages[1].content.slice(2)
    await retrySyntheticContinuation({
      response: failure(),
      enabled: true,
      body: JSON.stringify(body),
      retry: async (value) => {
        const replay = JSON.parse(value)
        expect(replay.messages[1].content[1].id).not.toBe("call_old")
        expect(replay.messages[2].content[0].tool_use_id).toBe(replay.messages[1].content[1].id)
        return new Response("recovered")
      },
    })
  })

  test("omits an assistant turn that contains only expired thinking", async () => {
    await retrySyntheticContinuation({
      response: failure(),
      enabled: true,
      body: JSON.stringify({
        messages: [
          transcript.messages[0],
          { role: "assistant", content: [{ type: "thinking", signature: "expired", thinking: "" }] },
        ],
      }),
      retry: async (value) => {
        expect(JSON.parse(value).messages).toEqual([transcript.messages[0]])
        return new Response("recovered")
      },
    })
  })

  test.each([undefined, "invalid JSON", JSON.stringify({ messages: [{ role: "user", content: "Hello" }] })])(
    "does not resubmit a body without recoverable history: %s",
    async (body) => {
      const response = failure()
      expect(
        await retrySyntheticContinuation({
          response,
          enabled: true,
          body,
          retry: async () => {
            throw new Error("Unexpected replay")
          },
        }),
      ).toBe(response)
    },
  )

  test("honors cancellation even after reading the rejection", async () => {
    const controller = new AbortController()
    const reason = new Error("User cancelled")
    const response = new Response(
      new ReadableStream({
        pull(stream) {
          stream.enqueue(
            new TextEncoder().encode(JSON.stringify({ error: { type: "invalid_request_error", message } })),
          )
          controller.abort(reason)
          stream.close()
        },
      }),
      { status: 400 },
    )
    expect(
      retrySyntheticContinuation({
        response,
        enabled: true,
        body: JSON.stringify(transcript),
        signal: controller.signal,
        retry: async () => {
          throw new Error("Unexpected replay")
        },
      }),
    ).rejects.toBe(reason)
  })

  test("recovers through the actual Messages SDK without running a completed tool again", async () => {
    let requests = 0
    let executions = 0
    const bodies: Record<string, unknown>[] = []
    const request = async (body: string) => {
      bodies.push(JSON.parse(body))
      if (++requests === 1) return failure()
      return Response.json({
        id: "msg_recovered",
        type: "message",
        role: "assistant",
        model: "gateway-model",
        content: [{ type: "text", text: "The saved report is ready." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 8 },
      })
    }
    const sdk = createAnthropic({
      apiKey: "test",
      baseURL: "https://gateway.test/v1",
      fetch: (async (_input, init) => {
        const body = String(init?.body)
        return retrySyntheticContinuation({ response: await request(body), enabled: true, body, retry: request })
      }) as typeof globalThis.fetch,
    })
    const result = await generateText({
      model: sdk("gateway-model"),
      maxRetries: 0,
      messages: [
        { role: "user", content: "Analyze the dataset" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "", providerOptions: { anthropic: { signature: "expired-state" } } },
            { type: "tool-call", toolCallId: "call_old", toolName: "analyze", input: { file: "dataset.csv" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_old",
              toolName: "analyze",
              output: { type: "text", value: "Saved report" },
            },
          ],
        },
      ],
      tools: {
        analyze: tool({
          inputSchema: jsonSchema<{ file: string }>({
            type: "object",
            properties: { file: { type: "string" } },
            required: ["file"],
          }),
          execute: async () => {
            executions++
            return "Duplicated analysis"
          },
        }),
      },
    })
    expect(result.text).toBe("The saved report is ready.")
    expect(requests).toBe(2)
    expect(executions).toBe(0)
    expect(JSON.stringify(bodies[0])).toContain("expired-state")
    expect(JSON.stringify(bodies[1])).not.toContain("expired-state")
    expect(JSON.stringify(bodies[1])).toContain("Saved report")
  })
})
