import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createOpenScienceClient } from "@synsci/sdk/v2/client"
import { createTestServer } from "../../../test/vite"

const vite = await createTestServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [subject, web] = await Promise.all([
  vite.ssrLoadModule("/src/components/settings/Connectors.tsx") as Promise<typeof import("./Connectors")>,
  vite.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: (() => void)[] = []
afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})
const ready = async (check: () => boolean) => {
  for (let index = 0; index < 150 && !check(); index++) await Bun.sleep(10)
  expect(check()).toBe(true)
}
let sequence = 0
function mount(read: (path: string, signal?: AbortSignal | null) => Promise<Response>) {
  const baseUrl = `http://connectors-${++sequence}.test`
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname
    if (path === "/settings/scientific-tools") return Response.json({ capabilities: [], connectors: [] })
    return read(path, input instanceof Request ? input.signal : init?.signal)
  }) as typeof fetch
  const services = {
    sdk: { client: createOpenScienceClient({ baseUrl, fetch: fetcher, throwOnError: true }) },
    sync: {
      data: { config: { mcp: { demo: { type: "local", command: ["node", "demo.js"], enabled: true } } } },
      set() {},
    },
    platform: { fetch: fetcher, openLink() {} },
    server: { url: baseUrl },
    dialog: {},
  } as unknown as NonNullable<Parameters<typeof subject.default>[0]>["services"]
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(() => subject.default({ services }), host)
  cleanups.push(dispose)
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text)!
  return { host, button, dispose }
}

test.each(["success", "failure"])("a late initial status %s cannot overwrite a newer refresh", async (outcome) => {
  const initial = Promise.withResolvers<Response>()
  let calls = 0
  const f = mount(async (path) => {
    expect(path).toBe("/mcp")
    calls++
    return calls === 1 ? initial.promise : Response.json({ demo: { status: "connected" } })
  })
  await ready(() => calls === 1)
  f.button("Refresh status").click()
  await ready(() => f.host.querySelector(".connectors-status")?.textContent?.trim() === "Connected")
  if (outcome === "success") initial.resolve(Response.json({ demo: { status: "disabled" } }))
  else initial.reject(new Error("Obsolete connection failure"))
  await Bun.sleep(20)
  expect(f.host.querySelector(".connectors-status")?.textContent?.trim()).toBe("Connected")
  expect(f.host.textContent).not.toContain("Obsolete connection failure")
})

test("structured HTTP errors from the real SDK expose the server reason and allow status retry", async () => {
  let calls = 0
  const f = mount(async (path) => {
    if (path === "/mcp") {
      if (++calls === 1) return Response.json({ message: "Fixture connector temporarily unavailable" }, { status: 503 })
      return Response.json({ demo: { status: "connected" } })
    }
    return Response.json({ error: { detail: "Connector capability discovery failed" } }, { status: 503 })
  })
  await ready(() => !!f.host.querySelector('[role="alert"]'))
  expect(f.host.textContent).toContain("Fixture connector temporarily unavailable")
  expect(f.host.textContent).not.toContain("[object Object]")
  f.button("Retry").click()
  await ready(() => f.host.querySelector(".connectors-status")?.textContent?.trim() === "Connected")
  f.host.querySelector<HTMLButtonElement>('[aria-label="Show demo details"]')!.click()
  await ready(() => !!f.host.querySelector('[role="alert"]'))
  expect(f.host.textContent).toContain("Connector capability discovery failed")
  expect(f.host.textContent).not.toContain("[object Object]")
})

test("status and inspection timeouts expose working retries instead of leaving settings busy", async () => {
  const timeout = globalThis.setTimeout
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => timeout(callback, delay === 30_000 ? 30 : delay, ...args)) as typeof setTimeout)
  let statusCalls = 0
  let inspectionCalls = 0
  try {
    const f = mount(async (path) => {
      if (path === "/mcp") {
        if (++statusCalls === 1) return new Promise(() => {})
        return Response.json({ demo: { status: "connected" } })
      }
      expect(path).toBe("/mcp/demo")
      if (++inspectionCalls === 1) return new Promise(() => {})
      return Response.json({
        name: "demo",
        status: { status: "connected" },
        auth: "not_required",
        tools: [{ name: "search_literature" }],
        resources: [],
        prompts: [],
        errors: {},
      })
    })
    await ready(() => f.host.textContent?.includes("Connector status unavailable") ?? false)
    f.button("Retry").click()
    await ready(() => f.host.querySelector(".connectors-status")?.textContent?.trim() === "Connected")
    f.host.querySelector<HTMLButtonElement>('[aria-label="Show demo details"]')!.click()
    await ready(() => f.host.textContent?.includes("Could not inspect this connector") ?? false)
    f.button("Retry").click()
    await ready(() => f.host.textContent?.includes("search_literature") ?? false)
    expect(f.host.textContent).not.toContain("Inspecting available tools")
    expect(statusCalls).toBe(2)
    expect(inspectionCalls).toBe(2)
  } finally {
    timer.mockRestore()
  }
})

test("unmounting connectors cancels pending status and inspection reads", async () => {
  const signals: AbortSignal[] = []
  const f = mount(async (_, signal) => {
    signals.push(signal!)
    return new Promise(() => {})
  })
  await ready(() => signals.length === 1)
  f.host.querySelector<HTMLButtonElement>('[aria-label="Show demo details"]')!.click()
  await ready(() => signals.length === 2)
  f.dispose()
  await Bun.sleep(20)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect(f.host.textContent).toBe("")
})
