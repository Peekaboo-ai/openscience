import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createTestServer } from "../../../test/vite"
import type { MemoryStore, MemoryServices, MemoryState } from "./memory-state"
import type { MemoryWorkspaces } from "./memory-workspaces"

const vite = await createTestServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const solid = (await vite.ssrLoadModule("solid-js")) as typeof import("solid-js")
const stores = (await vite.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const subject = (await vite.ssrLoadModule(
  "/src/components/settings/memory-state.ts",
)) as typeof import("./memory-state")
const cleanups: (() => void)[] = []
const ready = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10)
  expect(check()).toBe(true)
}
const initial = (): MemoryStore => ({
  version: 1,
  revision: 1,
  enabled: true,
  notes: [],
  categories: [{ id: "about-you", name: "About you", description: "", autoRecall: true }],
})
async function mount() {
  const [sdk, setSDK] = stores.createStore({ url: "http://local.test" })
  const [workspace, setWorkspace] = stores.createStore<MemoryWorkspaces["state"]>({
    projects: [],
    remotes: [
      {
        id: "bio",
        name: "Bio",
        projectID: "prj_bio",
        target: { kind: "ssh", host_id: "bio" },
        state: "connected",
        progress: "",
      },
    ],
    tasksProjectID: "",
    ready: true,
    selected: "",
    error: "",
    mobileOpen: false,
  })
  const records: Record<string, MemoryStore> = {
    "http://local.test": initial(),
    "http://remote.test": { ...initial(), revision: 10 },
  }
  let intercept: ((url: URL, init: RequestInit) => Promise<Response | undefined>) | undefined
  const request = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const custom = await intercept?.(url, init)
    if (custom) return custom
    if (url.pathname.endsWith("/catalog"))
      return Response.json({ projects: [{ id: "prj_bio", name: "Bio" }], sessions: [] })
    if (url.pathname.endsWith("/preview"))
      return Response.json({
        included: [],
        omitted: [],
        inherited: 0,
        characters: 0,
        maxCharacters: 12000,
        maxNotes: 20,
      })
    if (init.method === "PATCH") {
      records[url.origin] = { ...records[url.origin], revision: records[url.origin].revision + 1 }
    }
    return Response.json(records[url.origin])
  }
  const services: MemoryServices = {
    sdk,
    platform: { fetch: request as typeof fetch },
    workspaces: {
      state: workspace,
      localUrl: sdk.url,
      remoteBase: () => "http://remote.test",
      refresh: async () => {},
      connect: async () => {},
    },
  }
  let memory!: MemoryState
  solid.createRoot((dispose) => {
    cleanups.push(dispose)
    memory = subject.createMemoryState(services)
  })
  await ready(() => !!memory.state.data && !memory.state.loading)
  return {
    memory,
    records,
    setSDK,
    setWorkspace,
    intercept: (handler?: typeof intercept) => {
      intercept = handler
    },
  }
}
afterEach(() => cleanups.splice(0).forEach((dispose) => dispose()))
afterAll(() => vite.close())

test("suspends dirty drafts, resumes unchanged values, and closes pristine editors", async () => {
  const { memory } = await mount()
  memory.openEditor({ kind: "note", scope: { kind: "global" } })
  expect(memory.draftDirty()).toBe(false)
  memory.setState("draft", "error", "Validation error")
  memory.setState("draft", "revision", 9)
  expect(memory.draftDirty()).toBe(false)
  memory.suspendEditor()
  expect(memory.state.editor).toBeUndefined()
  memory.openEditor({ kind: "note", scope: { kind: "session", projectID: "prj_a", sessionID: "ses_a" } })
  memory.setState("draft", "title", "Keep this draft")
  memory.setState("draft", "content", "Record uncertainty intervals.")
  memory.setState("draft", "expires", "2026-10-15T23:30")
  memory.suspendEditor()
  expect(memory.state.editorOpen).toBe(false)
  expect(memory.draftDirty()).toBe(true)
  memory.setState({ projectID: "prj_b", sessionID: "ses_b", category: "all" })
  memory.resumeEditor()
  expect(memory.state.editorOpen).toBe(true)
  expect(memory.state.draft?.scope).toEqual({ kind: "session", projectID: "prj_a", sessionID: "ses_a" })
  expect(memory.state.draft?.expires).toBe("2026-10-15T23:30")
  memory.closeEditor()
  expect(memory.state.draft).toBeUndefined()
})

test("gives every replacement editor a new identity without changing it on resume", async () => {
  const { memory } = await mount()
  expect(memory.state.editorVersion).toBe(0)
  memory.openEditor({ kind: "note", scope: { kind: "session", projectID: "prj_a", sessionID: "ses_a" } })
  const first = memory.state.editorVersion
  memory.setState("draft", "title", "Keep this draft")
  memory.suspendEditor()
  memory.resumeEditor()
  expect(memory.state.editorVersion).toBe(first)
  memory.openEditor({ kind: "category" })
  expect(memory.state.editorVersion).toBe(first + 1)
  expect(memory.state.editor).toEqual({ kind: "category" })
  expect(memory.state.draft?.scope).toEqual({ kind: "global" })
  memory.openEditor({ kind: "category" })
  expect(memory.state.editorVersion).toBe(first + 2)
})

test("keeps same-source drafts across disconnect and reconnect", async () => {
  const { memory, setWorkspace } = await mount()
  memory.selectServer("bio")
  await ready(() => memory.state.data?.revision === 10)
  memory.openEditor({ kind: "note", scope: { kind: "project", projectID: "prj_bio" } })
  memory.setState("draft", "content", "Use the remote scheduler.")
  const before = JSON.stringify(memory.state.draft)
  setWorkspace("remotes", 0, "state", "disconnected")
  await ready(() => !memory.state.data)
  expect(JSON.stringify(memory.state.draft)).toBe(before)
  expect(memory.state.editorOpen).toBe(true)
  setWorkspace("remotes", 0, "state", "connected")
  await ready(() => memory.state.data?.revision === 10)
  expect(JSON.stringify(memory.state.draft)).toBe(before)
  expect(memory.draftDirty()).toBe(true)
})

test("isolates server drafts and restores their original revisions and dirty baselines", async () => {
  const { memory } = await mount()
  memory.openEditor({ kind: "note", scope: { kind: "global" } })
  memory.setState("draft", "title", "Local preference")
  memory.suspendEditor()
  memory.selectServer("bio")
  await ready(() => memory.state.data?.revision === 10)
  expect(memory.state.draft).toBeUndefined()
  memory.openEditor({ kind: "category" })
  memory.setState("draft", "title", "Remote conventions")
  memory.selectServer("")
  await ready(() => memory.state.data?.revision === 1)
  expect(memory.state.draft?.title).toBe("Local preference")
  expect(memory.state.draft?.revision).toBe(1)
  expect(memory.state.editor?.kind).toBe("note")
  expect(memory.state.editorOpen).toBe(false)
  expect(memory.draftDirty()).toBe(true)
  memory.selectServer("bio")
  await ready(() => memory.state.data?.revision === 10)
  expect(memory.state.draft?.title).toBe("Remote conventions")
  expect(memory.state.draft?.revision).toBe(10)
  expect(memory.state.editor).toEqual({ kind: "category" })
  expect(memory.state.draft?.scope).toEqual({ kind: "global" })
  expect(memory.draftDirty()).toBe(true)
})

test("older refreshes cannot clear a category from a newer store revision", async () => {
  const { memory, records, intercept } = await mount()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const old = structuredClone(records["http://local.test"])
  intercept(async (url, init) => {
    if (url.pathname !== "/settings/memory" || init.method) return
    entered.resolve()
    await release.promise
    return Response.json(old)
  })
  memory.refresh()
  await entered.promise
  records["http://local.test"].categories.push({ id: "research", name: "Research", description: "", autoRecall: true })
  await memory.save("", "PATCH", { enabled: true }, "Saved")
  memory.setState("category", "research")
  release.resolve()
  await ready(() => !memory.state.loading)
  expect(memory.state.data?.revision).toBe(2)
  expect(memory.state.category).toBe("research")
})

test("a delayed write response cannot roll back a newer refresh", async () => {
  const { memory, records, intercept } = await mount()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  intercept(async (url, init) => {
    if (url.pathname !== "/settings/memory" || init.method !== "PATCH") return
    const response = { ...records[url.origin], revision: 2, enabled: false }
    entered.resolve()
    await release.promise
    return Response.json(response)
  })
  const saving = memory.save("", "PATCH", { enabled: false }, "Saved")
  await entered.promise
  records["http://local.test"] = { ...initial(), revision: 3, enabled: true }
  memory.refresh()
  await ready(() => memory.state.data?.revision === 3)
  release.resolve()
  expect(await saving).toBe(true)
  expect(memory.state.data?.revision).toBe(3)
  expect(memory.state.data?.enabled).toBe(true)
  expect(memory.state.writing).toBe(false)
})
