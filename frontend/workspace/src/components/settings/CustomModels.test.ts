import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const context = `
const limits = Object.fromEntries([['alpha', 1050000, 128000], ['beta', 64000, 8000], ['gamma', 128000, 32000]].map(([id, context, output]) => [id, {context, output, mode: 'auto', source: 'catalog'}]))
const fallback = { context: 128000, output: 32000, mode: 'auto', source: 'fallback' }
export const state = { connections: [], writes: [], refreshes: 0, revealed: [], fail: false, refreshWait: undefined, refreshFailure: false, reads: 0 }
export const useGlobalSDK = () => ({ url: "http://fixture.invalid" })
export const useGlobalSync = () => ({ refreshProviders: async () => { state.refreshes++; await state.refreshWait; if (state.refreshFailure) throw new Error('Offline') } })
export const useModels = () => ({ setVisibility: value => state.revealed.push(value) })
export const useDialog = () => ({})
export const confirmDialog = async () => true
export const showToast = () => {}
export const usePlatform = () => ({ fetch: async (url, init) => {
  if (url.endsWith("/models")) {
    if (state.fail) return Response.json({ error: "The endpoint rejected this API key." }, { status: 401 })
    return Response.json({ baseURL: "https://gateway.test/v1", models: ["alpha", "beta", "gamma"], limits })
  }
  if (url.endsWith('/limits')) return Response.json({ limits: Object.fromEntries(JSON.parse(init.body).models.map(id => [id, limits[id] ?? fallback])) })
  if (init?.method === "POST") {
    const body = JSON.parse(init.body)
    state.writes.push(body)
    const id = body.id || "custom-test"
    state.connections = [{ id, name: body.name, baseURL: body.url, models: body.models, hasKey: true, context: 128000, output: 32000, limits: body.limits }]
    return Response.json(state.connections[0])
  }
  if (init?.method === "DELETE") { state.connections = []; return Response.json({ removed: true }) }
  state.reads++
  return Response.json({ connections: state.connections })
} })
`
const imports = new Set([
  "@/context/global-sdk",
  "@/context/global-sync",
  "@/context/models",
  "@/context/platform",
  "@/atlas/dialogs",
  "@synsci/ui/context/dialog",
  "@synsci/ui/toast",
  ...["global-sdk", "global-sync", "models", "platform"].map((name) => `${root}/src/context/${name}`),
  `${root}/src/atlas/dialogs`,
])
const server = await createTestServer({
  configFile: false,
  root,
  logLevel: "silent",
  plugins: [
    {
      name: "custom-model-context",
      enforce: "pre",
      resolveId: (id) => (imports.has(id) ? "\0custom-model-context" : undefined),
      load: (id) => (id === "\0custom-model-context" ? context : undefined),
    },
    solid({ ssr: false, dev: false }),
  ],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { alias: { "@": `${root}/src` }, conditions: ["browser", "production"], dedupe: ["solid-js"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const component = (await server.ssrLoadModule(
  "/src/components/settings/CustomModels.tsx",
)) as typeof import("./CustomModels")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const fixture = (await server.ssrLoadModule("\0custom-model-context")) as {
  state: {
    connections: unknown[]
    writes: Array<{
      key?: string
      models: string[]
      limits: Record<string, { context: number; output: number; mode: string }>
    }>
    refreshes: number
    revealed: unknown[]
    fail: boolean
    refreshWait?: Promise<void>
    refreshFailure: boolean
    reads: number
  }
}
const cleanups: Array<() => void> = []
afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  document.body.replaceChildren()
  Object.assign(fixture.state, {
    connections: [],
    writes: [],
    refreshes: 0,
    revealed: [],
    fail: false,
    refreshWait: undefined,
    refreshFailure: false,
    reads: 0,
  })
})
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("UI did not settle")
}
const button = (name: string) => [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === name)!
const input = (name: string) =>
  [...document.querySelectorAll("label")].find((el) => el.textContent?.trim() === name)?.querySelector("input")!
function fill(el: HTMLInputElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event("input", { bubbles: true }))
}
async function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => component.CustomModels(), host))
  await until(() => !!button("Add connection"))
  button("Add connection").click()
  fill(input("Connection name"), "Fixture gateway")
  fill(input("API base URL"), "https://gateway.test/v1")
  fill(input("API key"), "test-only-key")
}

test("searches, selects multiple models, saves, edits without exposing the key and removes", async () => {
  await mount()
  button("Fetch models").click()
  await until(() => document.querySelectorAll('input[type="checkbox"]').length === 3)
  const checks = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  checks[0].click()
  checks[1].click()
  fill(document.querySelector<HTMLInputElement>('input[type="search"]')!, "gamma")
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
  button("Save connection").click()
  await until(() => !!button("Edit"))
  expect(fixture.state.writes[0].models).toEqual(["alpha", "beta"])
  expect(fixture.state.revealed).toHaveLength(2)
  expect(fixture.state.refreshes).toBe(1)
  button("Edit").click()
  expect(input("API key").value).toBe("")
  document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click()
  button("Save changes").click()
  await until(() => fixture.state.writes.length === 2 && button("Edit")?.disabled === false)
  expect(fixture.state.writes[1]).toMatchObject({ models: ["alpha"] })
  expect(fixture.state.writes[1].key).toBeUndefined()
  button("Remove").click()
  await until(() => !button("Edit"))
  expect(fixture.state.connections).toHaveLength(0)
})

test("discovery errors preserve the form, recover controls, and permit manual model IDs", async () => {
  await mount()
  fixture.state.fail = true
  button("Fetch models").click()
  await until(() => !!document.querySelector('[role="alert"]'))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("rejected this API key")
  expect(button("Fetch models").disabled).toBe(false)
  expect(input("Connection name").value).toBe("Fixture gateway")
  fill(input("Add a model ID manually"), "private/model")
  button("Add model").click()
  await until(() => !button("Save connection").disabled)
  button("Save connection").click()
  await until(() => !!button("Edit"))
  expect(fixture.state.writes[0].models).toEqual(["private/model"])
  button("Edit").click()
  fill(input("API base URL"), "https://another.test/v1")
  expect(button("Fetch models").disabled).toBe(true)
  expect(button("Save changes").disabled).toBe(true)
})

test("per-model defaults, manual overrides and resetting detection survive save without remounting", async () => {
  await mount()
  button("Fetch models").click()
  await until(() => document.querySelectorAll('input[type="checkbox"]').length === 3)
  const checks = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  checks[0].click()
  checks[1].click()
  const context = (id: string) => document.querySelector<HTMLInputElement>(`[aria-label="${id} context tokens"]`)!
  expect(context("alpha").value).toBe("1050000")
  expect(context("beta").value).toBe("64000")
  fill(context("alpha"), "256000")
  button("Fetch models").click()
  await until(() => button("Fetch models")?.disabled === false)
  expect(context("alpha").value).toBe("256000")
  button("Use detected limits").click()
  await until(() => button("Fetch models")?.disabled === false)
  expect(context("alpha").value).toBe("1050000")
  fill(context("beta"), "48000")
  fill(input("API key"), "replacement-key")
  expect(context("beta").value).toBe("48000")
  expect(button("Save connection").disabled).toBe(false)
  const form = document.querySelector("form")
  let release!: () => void
  fixture.state.refreshWait = new Promise<void>((resolve) => {
    release = resolve
  })
  button("Save connection").click()
  await until(() => button("Save changes")?.disabled === false)
  expect(document.querySelector("form")).toBe(form)
  expect(context("beta").value).toBe("48000")
  expect(fixture.state.writes[0].limits).toMatchObject({
    alpha: { context: 1050000, output: 128000, mode: "auto" },
    beta: { context: 48000, output: 8000, mode: "manual" },
  })
  expect(fixture.state.reads).toBe(1)
  expect(fixture.state.refreshes).toBe(1)
  expect(input("API key").value).toBe("")
  input("Connection name").focus()
  fill(input("Connection name"), "Still editable")
  fixture.state.refreshFailure = true
  release()
  await until(() => !!document.querySelector('[role="alert"]'))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Changes saved")
  expect(document.activeElement).toBe(input("Connection name"))
  expect(input("Connection name").value).toBe("Still editable")
})
