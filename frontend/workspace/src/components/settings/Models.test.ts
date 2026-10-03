import { afterAll, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"

const root = fileURLToPath(new URL("../../..", import.meta.url))
const context = `
import { createStore } from 'solid-js/store'
const [state, setState] = createStore({ hidden: {}, pinned: [] })
const catalog = Array.from({length: 60}, (_, i) => ({
  id: 'model-' + String(i).padStart(2, '0'), name: 'Model ' + String(i).padStart(2, '0'),
  provider: {id: 'custom-review', name: 'Review'}, capabilities: {reasoning: true, output: {text: true}},
  limit: {context: 128000, output: 4096}, cost: {input: 0, output: 0, cache: {read: 0, write: 0}},
}))
export const useModels = () => ({
  list: () => catalog, recent: {list: () => []},
  visible: key => !state.hidden[key.modelID],
  setVisibility: (key, checked) => setState('hidden', key.modelID, !checked),
  pinned: {list: () => state.pinned, has: key => state.pinned.some(v => v.modelID === key.modelID),
    toggle: key => { const pinned = !state.pinned.some(v => v.modelID === key.modelID); setState('pinned', pinned ? [...state.pinned, key] : state.pinned.filter(v => v.modelID !== key.modelID)); return {pinned} }},
})
export const useGlobalSDK = () => ({url: 'http://fixture.invalid'})
export const useGlobalSync = () => ({data: {config: {}}, onProvidersRefreshed: () => () => {}})
export const writes = { pending: undefined, values: [] }
export const usePlatform = () => ({fetch: async (_url, init) => {
  if (init?.method === 'PATCH') {
    const value = JSON.parse(init.body)
    writes.values.push(value)
    await writes.pending
    return Response.json(value)
  }
  return Response.json({delegation_worker_model: null, llm: 'byok'})
}})
export const CodexConnection = () => null
export const ProviderKeys = () => null
export const CustomModels = () => null
`
const vite = await createTestServer({
  root,
  logLevel: "silent",
  plugins: [
    {
      name: "models-context",
      enforce: "pre",
      resolveId: (id, importer) =>
        /(?:@\/|\/src\/)context\/(global-sdk|global-sync|models|platform)(?:\.tsx?)?$/.test(id.replaceAll("\\", "/")) ||
        (importer?.endsWith("/Models.tsx") && ["./CodexConnection", "./ProviderKeys", "./CustomModels"].includes(id))
          ? "\0models-context"
          : undefined,
      load: (id) => (id === "\0models-context" ? context : undefined),
    },
    solid({ ssr: false, dev: false }),
  ],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const { default: Models } = (await vite.ssrLoadModule(
  "/src/components/settings/Models.tsx",
)) as typeof import("./Models")
const fixture = (await vite.ssrLoadModule("\0models-context")) as {
  writes: { pending?: Promise<void>; values: { delegation_worker_model: { modelID: string } | null }[] }
}
afterAll(() => vite.close())

test("changing visibility preserves expanded rows, their identity, and keyboard focus", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(() => web.createComponent(Models, {}), host)
  const button = (name: string) => [...host.querySelectorAll("button")].find((el) => el.textContent?.trim() === name)!
  const rows = () => host.querySelectorAll(".settings-model-row")
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    button("Edit").click()
    expect(rows()).toHaveLength(24)
    button("Show more").click()
    expect(rows()).toHaveLength(48)
    const row = rows()[38]
    const control = row.querySelector<HTMLInputElement>('input[role="switch"]')!
    control.focus()
    control.click()
    expect(control.checked).toBe(false)
    expect(rows()).toHaveLength(48)
    expect(rows()[38]).toBe(row)
    expect(document.activeElement).toBe(control)
    const search = host.querySelector<HTMLInputElement>('[aria-label="Filter models"]')!
    search.value = "Model 59"
    search.dispatchEvent(new Event("input", { bubbles: true }))
    expect(rows()).toHaveLength(1)
    expect(rows()[0].textContent).toContain("Model 59")
    search.value = ""
    search.dispatchEvent(new Event("input", { bubbles: true }))
    expect(rows()).toHaveLength(24)
  } finally {
    dispose()
    host.remove()
  }
})

test("worker model saves prevent overlapping writes and unlock when the server confirms the selection", async () => {
  const response = Promise.withResolvers<void>()
  fixture.writes.pending = response.promise
  fixture.writes.values = []
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(() => web.createComponent(Models, {}), host)
  const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="Worker model"]')!
  try {
    for (let index = 0; index < 100 && trigger()?.disabled !== false; index++) await Bun.sleep(10)
    expect(trigger().disabled).toBe(false)
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await Bun.sleep(20)
    const choice = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
      item.textContent?.includes("Model 00"),
    )!
    expect(choice).toBeDefined()
    choice.click()
    for (let index = 0; index < 100 && fixture.writes.values.length === 0; index++) await Bun.sleep(10)
    expect(fixture.writes.values).toHaveLength(1)
    expect(trigger().disabled).toBe(true)
    trigger().click()
    expect(fixture.writes.values).toHaveLength(1)
    response.resolve()
    for (let index = 0; index < 100 && trigger().disabled; index++) await Bun.sleep(10)
    expect(trigger().disabled).toBe(false)
    expect(trigger().textContent).toContain("Model 00")

    const failed = Promise.withResolvers<void>()
    fixture.writes.pending = failed.promise
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await Bun.sleep(20)
    const next = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
      item.textContent?.includes("Model 01"),
    )!
    next.click()
    for (let index = 0; index < 100 && fixture.writes.values.length < 2; index++) await Bun.sleep(10)
    expect(trigger().disabled).toBe(true)
    failed.reject(new Error("Connection lost"))
    for (let index = 0; index < 100 && trigger().disabled; index++) await Bun.sleep(10)
    expect(trigger().disabled).toBe(false)
    expect(trigger().textContent).toContain("Model 00")
    expect(host.textContent).toContain("Connection lost")
  } finally {
    response.resolve()
    fixture.writes.pending = undefined
    dispose()
    host.remove()
  }
})
