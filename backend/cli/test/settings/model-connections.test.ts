import { afterAll, expect, test } from "bun:test"
import { generateText } from "ai"
import { CustomConnections } from "../../src/provider/custom-connections"
import { ModelConnectionsRoutes } from "../../src/server/routes/settings/model-connections"
import { Config } from "../../src/config/config"
import { Auth } from "../../src/auth"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const requests: { url: string; key: string | null; body?: unknown }[] = []
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req): Promise<Response> {
    const url = new URL(req.url)
    requests.push({
      url: url.pathname,
      key: req.headers.get("authorization"),
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
    return new Response("Not found", { status: 404 })
  },
})
afterAll(() => server.stop(true))
const base = server.url.toString().replace(/\/$/, "")

test("normalizes base URLs without changing gateway prefixes", () => {
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

test("discovers and deduplicates models, rejects redirects and sanitizes upstream errors", async () => {
  expect(await CustomConnections.discover({ url: base, key: "fixture-key" })).toEqual({
    baseURL: `${base}/v1`,
    models: ["lab/alpha", "lab/beta"],
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
