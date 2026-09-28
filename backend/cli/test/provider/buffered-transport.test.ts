import { expect, test } from "bun:test"
import { streamText, stepCountIs, tool, jsonSchema } from "ai"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { ProviderTransform } from "../../src/provider/transform"

function config(url: string, streaming?: boolean) {
  return {
    provider: {
      diagnostic: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: url, apiKey: "test-key", ...(streaming === undefined ? {} : { streaming }) },
        models: { probe: { limit: { context: 32000, output: 1024 }, tool_call: true } },
      },
    },
  }
}

test("buffered transport preserves task, history, reasoning, tool result and usage through the real SDK", async () => {
  const requests: {
    stream?: boolean
    reasoning_effort?: string
    messages: { role: string; content: string; tool_call_id?: string }[]
  }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json()
      requests.push(body)
      const first = requests.length === 1
      return Response.json({
        id: `response-${requests.length}`,
        object: "chat.completion",
        created: 1,
        model: "probe",
        choices: [
          {
            index: 0,
            message: first
              ? {
                  role: "assistant",
                  content: null,
                  reasoning_content: "Checking the environment.",
                  tool_calls: [
                    {
                      id: "call-probe",
                      type: "function",
                      function: { name: "inspect", arguments: '{"name":"onezone"}' },
                    },
                  ],
                }
              : { role: "assistant", content: "onezone is available; continue the GEO task." },
            finish_reason: first ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    },
  })
  try {
    await using tmp = await tmpdir({ config: config(server.url.href + "v1", false) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await Provider.getModel("diagnostic", "probe")
        info.capabilities.reasoning = true
        info.reasoningOptions = [{ type: "effort", values: ["low", "high", "xhigh"], default: "high" }]
        const model = await Provider.getLanguage(info)
        const defaults = ProviderTransform.options({ model: info, sessionID: "test" })
        expect(defaults.reasoningEffort).toBe("high")
        const calls: string[] = []
        const result = streamText({
          model,
          providerOptions: ProviderTransform.providerOptions(info, {
            ...defaults,
            ...ProviderTransform.variants(info).xhigh,
          }),
          messages: [
            { role: "system", content: "Research assistant" },
            { role: "user", content: "Use onezone for GEO GSE2034." },
          ],
          tools: {
            inspect: tool({
              inputSchema: jsonSchema<{ name: string }>({
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              }),
              execute: async ({ name }) => {
                calls.push(name)
                return "onezone available"
              },
            }),
          },
          stopWhen: stepCountIs(2),
          maxRetries: 0,
        })
        expect(await result.text).toBe("onezone is available; continue the GEO task.")
        expect(calls).toEqual(["onezone"])
        expect(requests).toHaveLength(2)
        expect(requests.every((body) => body.stream !== true)).toBe(true)
        expect(requests.every((body) => body.reasoning_effort === "xhigh")).toBe(true)
        expect(requests[0].messages).toEqual([
          { role: "system", content: "Research assistant" },
          { role: "user", content: "Use onezone for GEO GSE2034." },
        ])
        expect(requests[1].messages.at(-1)).toMatchObject({
          role: "tool",
          tool_call_id: "call-probe",
          content: "onezone available",
        })
        expect((await result.steps)[0].reasoningText).toBe("Checking the environment.")
        expect((await result.totalUsage).inputTokens).toBe(20)
        expect((await result.totalUsage).outputTokens).toBe(10)
      },
    })
  } finally {
    await server.stop(true)
  }
})

test("default transport still sends a streaming request", async () => {
  let streaming: unknown
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      streaming = (await request.json()).stream
      const chunk = {
        id: "native",
        created: 1,
        model: "probe",
        choices: [{ index: 0, delta: { content: "native stream" }, finish_reason: "stop" }],
      }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  try {
    await using tmp = await tmpdir({ config: config(server.url.href + "v1") })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = await Provider.getLanguage(await Provider.getModel("diagnostic", "probe"))
        expect(await streamText({ model, prompt: "test", maxRetries: 0 }).text).toBe("native stream")
        expect(streaming).toBe(true)
      },
    })
  } finally {
    await server.stop(true)
  }
})

test("buffered transport forwards cancellation without retrying", async () => {
  const received = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let count = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      count++
      received.resolve()
      await release.promise
      return new Response("{}")
    },
  })
  try {
    await using tmp = await tmpdir({ config: config(server.url.href + "v1", false) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = await Provider.getLanguage(await Provider.getModel("diagnostic", "probe"))
        const controller = new AbortController()
        const pending = Promise.resolve(
          model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
            abortSignal: controller.signal,
          }),
        )
        void pending.catch(() => undefined)
        try {
          await Promise.race([
            received.promise,
            Bun.sleep(3000).then(() => {
              throw new Error("Request was not dispatched")
            }),
          ])
          controller.abort()
          await expect(pending).rejects.toThrow()
        } finally {
          controller.abort()
          release.resolve()
        }
        expect(count).toBe(1)
      },
    })
  } finally {
    release.resolve()
    await server.stop(true)
  }
})

test("buffered transport preserves provider failure without a second paid request", async () => {
  let count = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      count++
      return Response.json(
        { error: { message: "invalid diagnostic credential", type: "authentication_error" } },
        { status: 401 },
      )
    },
  })
  try {
    await using tmp = await tmpdir({ config: config(server.url.href + "v1", false) })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = await Provider.getLanguage(await Provider.getModel("diagnostic", "probe"))
        await expect(
          model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] }),
        ).rejects.toMatchObject({ statusCode: 401 })
        expect(count).toBe(1)
      },
    })
  } finally {
    await server.stop(true)
  }
})
