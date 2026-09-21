import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const context = `
export const state = { connections: [], writes: [], refreshes: 0, revealed: [], fail: false }
export const useGlobalSDK = () => ({ url: "http://fixture.invalid" })
export const useGlobalSync = () => ({ refreshProviders: async () => { state.refreshes++ } })
export const useModels = () => ({ setVisibility: value => state.revealed.push(value) })
export const useDialog = () => ({})
export const confirmDialog = async () => true
export const showToast = () => {}
export const usePlatform = () => ({ fetch: async (url, init) => {
  if (url.endsWith("/models")) {
    if (state.fail) return Response.json({ error: "The endpoint rejected this API key." }, { status: 401 })
    return Response.json({ baseURL: "https://gateway.test/v1", models: ["alpha", "beta", "gamma"] })
  }
  if (init?.method === "POST") {
    const body = JSON.parse(init.body)
    state.writes.push(body)
    const id = body.id || "custom-test"
    state.connections = [{ id, name: body.name, baseURL: body.url, models: body.models, hasKey: true, context: body.context, output: body.output }]
    return Response.json({ id, models: body.models })
  }
  if (init?.method === "DELETE") { state.connections = []; return Response.json({ removed: true }) }
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
    writes: Array<{ key?: string; models: string[] }>
    refreshes: number
    revealed: unknown[]
    fail: boolean
  }
}
const cleanups: Array<() => void> = []
afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  document.body.replaceChildren()
  Object.assign(fixture.state, { connections: [], writes: [], refreshes: 0, revealed: [], fail: false })
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
  button("Save connection").click()
  await until(() => !!button("Edit"))
  expect(fixture.state.writes[0].models).toEqual(["private/model"])
  button("Edit").click()
  fill(input("API base URL"), "https://another.test/v1")
  expect(button("Fetch models").disabled).toBe(true)
  expect(button("Save changes").disabled).toBe(true)
})
