import { afterAll, expect, test } from "bun:test"
import { generateText } from "ai"
import { CustomConnections } from "../../src/provider/custom-connections"
import { ModelConnectionsRoutes } from "../../src/server/routes/settings/model-connections"
import { Config } from "../../src/config/config"
import { Auth } from "../../src/auth"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SessionCompaction } from "../../src/session/compaction"
import { ProviderTransform } from "../../src/provider/transform"

const requests: { url: string; key: string | null; apiKey: string | null; body?: unknown }[] = []
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req): Promise<Response> {
    const url = new URL(req.url)
    requests.push({
      url: url.pathname,
      key: req.headers.get("authorization"),
      apiKey: req.headers.get("x-api-key"),
      body: req.method === "POST" ? await req.json() : undefined,
    })
    if (url.pathname === "/denied/models") return new Response("fixture-secret-must-not-leak", { status: 401 })
    if (url.pathname === "/redirect/models") return Response.redirect(`${server.url}v1/models`)
    if (url.pathname === "/invalid/models") return new Response("<html>Not an API</html>")
    if (url.pathname === "/large/models") return new Response(" ".repeat(2 * 1024 * 1024 + 1))
    if (url.pathname.endsWith("/models"))
      return Response.json({ data: [{ id: "lab/beta" }, { id: "lab/alpha" }, { id: "lab/beta" }, { id: "" }] })
    if (url.pathname === "/v1/chat/completions")
      return Response.json({
        id: "fixture-completion",
        object: "chat.completion",
        created: 1,
        model: "lab/alpha",
        choices: [
          { index: 0, message: { role: "assistant", content: "Connected successfully" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      })
    if (url.pathname === "/v1/messages")
      return Response.json({
        id: "fixture-message",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{ type: "text", text: "Connected successfully" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      })
    if (url.pathname === "/v1/responses")
      return Response.json({
        id: "fixture-response",
        object: "response",
        created_at: 1,
        model: "gpt-5.6-sol",
        status: "completed",
        output: [
          {
            type: "message",
            id: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Connected successfully", annotations: [] }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      })
    return new Response("Not found", { status: 404 })
  },
})
afterAll(() => server.stop(true))
const base = server.url.toString().replace(/\/$/, "")

test("normalizes base URLs without changing gateway prefixes", () => {
  for (const suffix of ["responses", "messages"]) {
    expect(CustomConnections.normalizeURL(`https://api.example.com/gateway/v1/${suffix}`)).toBe(
      "https://api.example.com/gateway/v1",
    )
  }
  expect(CustomConnections.normalizeURL("https://api.example.com/")).toBe("https://api.example.com/v1")
  expect(CustomConnections.normalizeURL("https://api.example.com/gateway/v2/models")).toBe(
    "https://api.example.com/gateway/v2",
  )
  expect(CustomConnections.normalizeURL("https://api.example.com/v1/chat/completions")).toBe(
    "https://api.example.com/v1",
  )
  for (const url of [
    "file:///tmp/models",
    "https://user:secret@example.com",
    "https://example.com?key=secret",
    "https://example.com/#key",
  ]) {
    expect(() => CustomConnections.normalizeURL(url)).toThrow()
  }
})

for (const protocol of ["anthropic-messages", "openai-responses"] as const) {
  test(`custom ${protocol} routes through its SDK and survives editing without disposing the project`, async () => {
    await using tmp = await tmpdir()
    const created = await CustomConnections.save({
      name: "Protocol fixture",
      url: base,
      key: "protocol-fixture-key",
      models: ["gpt-5.6-sol"],
      protocol,
      thinking: "adaptive",
    })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const sentinel = Instance.state(() => ({}))
          const current = sentinel()
          const model = await Provider.getModel(created.id, "gpt-5.6-sol")
          const options = {
            ...ProviderTransform.options({ model, sessionID: "protocol-test" }),
            ...model.options,
            ...model.variants?.xhigh,
          }
          const result = await generateText({
            model: await Provider.getLanguage(model),
            prompt: "保留原始任务内容",
            providerOptions: ProviderTransform.providerOptions(model, options),
            maxOutputTokens: 4096,
            maxRetries: 0,
          })
          expect(result.text).toBe("Connected successfully")
          if (protocol === "anthropic-messages") {
            expect(requests.at(-1)).toMatchObject({
              url: "/v1/messages",
              key: "Bearer protocol-fixture-key",
              apiKey: "protocol-fixture-key",
              body: {
                thinking: { type: "adaptive" },
                output_config: { effort: "xhigh" },
                messages: [{ role: "user", content: [{ type: "text", text: "保留原始任务内容" }] }],
              },
            })
            expect(options).not.toHaveProperty("reasoningEffort")
            await CustomConnections.discover({ id: created.id, url: base })
            expect(requests.at(-1)?.apiKey).toBe("protocol-fixture-key")
          } else {
            expect(requests.at(-1)).toMatchObject({
              url: "/v1/responses",
              body: { reasoning: { effort: "xhigh" }, store: false },
            })
          }
          const edited = await CustomConnections.save({
            id: created.id,
            name: "Edited",
            url: base,
            models: created.models,
          })
          expect(edited.protocol).toBe(protocol)
          expect(edited.thinking).toBe(protocol === "anthropic-messages" ? "adaptive" : "auto")
          expect((await CustomConnections.list()).find((item) => item.id === created.id)?.protocol).toBe(protocol)
          expect(sentinel()).toBe(current)
          await CustomConnections.save({
            id: created.id,
            name: "Chat",
            url: base,
            models: created.models,
            protocol: "openai-chat-completions",
          })
          const switched = await Provider.getModel(created.id, "gpt-5.6-sol")
          expect(switched.api.npm).toBe("@ai-sdk/openai-compatible")
          expect(switched.options.thinking).toBeUndefined()
          expect(await Auth.get(created.id)).toEqual({ type: "api", key: "protocol-fixture-key" })
        },
      })
    } finally {
      await CustomConnections.remove(created.id)
    }
  })
}

test("discovers and deduplicates models, rejects redirects and sanitizes upstream errors", async () => {
  expect(await CustomConnections.discover({ url: base, key: "fixture-key" })).toMatchObject({
    baseURL: `${base}/v1`,
    models: ["lab/alpha", "lab/beta"],
    limits: { "lab/alpha": { context: 128_000, output: 32_000, source: "fallback" } },
  })
  expect(requests.at(-1)?.key).toBe("Bearer fixture-key")
  for (const suffix of ["denied", "redirect", "invalid", "large"]) {
    const response = await ModelConnectionsRoutes().request("/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${base}/${suffix}`, key: "fixture-key" }),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain("fixture-secret-must-not-leak")
  }
  expect(CustomConnections.parseModels({ models: [{ name: "one" }, "two", null] })).toEqual(["one", "two"])
  expect(() => CustomConnections.parseModels({ error: "bad response" })).toThrow()
})

test("saved connections route real completions, replace selections and keep secrets out of config and listing", async () => {
  await using tmp = await tmpdir()
  const created = await CustomConnections.save({
    name: "Test gateway",
    url: base,
    key: "fixture-key",
    models: ["lab/alpha", "lab/beta"],
  })
  try {
    expect(JSON.stringify((await Config.getGlobal()).provider?.[created.id])).not.toContain("fixture-key")
    expect(JSON.stringify(await CustomConnections.list())).not.toContain("fixture-key")
    expect((await CustomConnections.list()).find((item) => item.id === created.id)?.hasKey).toBe(true)
    expect((await CustomConnections.discover({ id: created.id, url: base })).models).toHaveLength(2)
    await expect(CustomConnections.discover({ id: created.id, url: `${base}/different` })).rejects.toThrow("new key")
    await expect(
      CustomConnections.save({ id: created.id, name: "Changed", url: `${base}/different`, models: ["lab/alpha"] }),
    ).rejects.toThrow("new key")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const provider = (await Provider.list())[created.id]
        expect(Object.keys(provider.models).sort()).toEqual(["lab/alpha", "lab/beta"])
        const language = await Provider.getLanguage(await Provider.getModel(created.id, "lab/alpha"))
        const result = await generateText({ model: language, prompt: "Hello", maxRetries: 0 })
        expect(result.text).toBe("Connected successfully")
        expect(requests.at(-1)).toMatchObject({
          url: "/v1/chat/completions",
          key: "Bearer fixture-key",
          body: { model: "lab/alpha" },
        })
        const saved = (await Config.getGlobal()).provider![created.id]
        await Config.setProvider(created.id, { ...saved, options: { ...saved.options, streaming: false } }, "global", {
          preserveInstances: true,
        })
        await CustomConnections.save({
          id: created.id,
          name: "Edited gateway",
          url: base,
          models: ["lab/alpha"],
          context: 65536,
          output: 4096,
        })
        expect(Object.keys((await Provider.list())[created.id].models)).toEqual(["lab/alpha"])
        expect((await Provider.list())[created.id].models["lab/alpha"].limit.context).toBe(65536)
        expect((await Config.getGlobal()).provider![created.id].options?.streaming).toBe(false)
        await CustomConnections.save({
          id: created.id,
          name: "Moved",
          url: `${base}/different`,
          key: "fixture-key",
          models: ["lab/alpha"],
        })
        expect((await Config.getGlobal()).provider![created.id].options?.streaming).toBeUndefined()
        await Auth.remove(created.id)
        Provider.invalidate()
        expect((await Provider.list())[created.id]).toBeUndefined()
      },
    })
  } finally {
    await CustomConnections.remove(created.id)
  }
  expect((await Config.getGlobal()).provider?.[created.id]).toBeUndefined()
  expect(await Auth.get(created.id)).toBeUndefined()
  await expect(CustomConnections.remove("openai")).rejects.toThrow()
})

test("rejects empty selections and invalid limits without storing a key", async () => {
  expect(() => CustomConnections.Input.parse({ name: "Test", url: base, key: "fixture-key", models: [] })).toThrow()
  expect(() =>
    CustomConnections.Input.parse({
      name: "Test",
      url: base,
      key: "fixture-key",
      models: ["one"],
      context: 1024,
      output: 2048,
    }),
  ).toThrow()
  await expect(
    CustomConnections.save({
      id: `custom-${crypto.randomUUID()}`,
      name: "Missing",
      url: base,
      key: "fixture-key",
      models: ["one"],
    }),
  ).rejects.toThrow("no longer exists")
})

test("catalog metadata alone does not connect an unconfigured provider", async () => {
  await using tmp = await tmpdir({
    config: { provider: { anthropic: { name: "Metadata only", whitelist: ["claude-opus-5"] } } },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect((await Provider.list()).anthropic).toBeUndefined()
    },
  })
})

test("per-model limits reach runtime and compaction without disposing a live project", async () => {
  await using tmp = await tmpdir()
  const created = await CustomConnections.save({
    name: "Limits fixture",
    url: base,
    key: "fixture-key",
    models: ["gpt-5.6-terra", "lab/small"],
    limits: { "lab/small": { context: 16384, output: 2048, input: 12000, mode: "manual", source: "manual" } },
  })
  const sentinel = Instance.state(() => ({ id: crypto.randomUUID() }))
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const state = sentinel()
        const model = await Provider.getModel(created.id, "gpt-5.6-terra")
        expect(model.limit).toEqual({ context: 1_050_000, input: 922_000, output: 128_000 })
        const budget = SessionCompaction.usableContext(model, {})
        expect(Math.floor(budget.usable * 0.9)).toBeGreaterThan(23_951)
        expect(budget.usable).toBeLessThan(model.limit.input!)
        expect(
          await SessionCompaction.isOverflow({
            model,
            tokens: {
              input: budget.usable,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          }),
        ).toBe(true)
        const saved = await CustomConnections.save({
          id: created.id,
          name: "Edited",
          url: base,
          models: created.models,
        })
        expect(saved.limits["lab/small"].input).toBe(12000)
        expect(sentinel()).toBe(state)
        expect((await Provider.getModel(created.id, "lab/small")).limit.input).toBe(12000)
        // 旧版本固定值在运行时升级，不需要覆盖用户文件才能解除错误预算。
        const block = (await Config.getGlobal()).provider![created.id]
        await Config.setProvider(
          created.id,
          {
            ...block,
            options: { baseURL: block.options!.baseURL, customConnection: true },
            models: { "gpt-5.6-terra": { limit: { context: 32768, output: 8192 } } },
            whitelist: ["gpt-5.6-terra"],
          },
          "global",
          { preserveInstances: true },
        )
        expect((await Provider.getModel(created.id, "gpt-5.6-terra")).limit.context).toBe(1_050_000)
        expect(
          (await CustomConnections.list()).find((item) => item.id === created.id)?.limits["gpt-5.6-terra"].input,
        ).toBe(922_000)
      },
    })
  } finally {
    await CustomConnections.remove(created.id)
  }
})
