import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createTestServer } from "../../../test/vite"
import type { SpecialistSnapshot, SpecialistProfile, SpecialistServices, SpecialistsState } from "./specialists-state"

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
const subject = (await vite.ssrLoadModule(
  "/src/components/settings/specialists-state.ts",
)) as typeof import("./specialists-state")
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((dispose) => dispose()))
afterAll(() => vite.close())
const profile = (): SpecialistProfile => ({
  ...subject.specialistDraft({ name: "biology", displayName: "Biology" }),
  source: "builtin",
  updatedAt: 0,
})

function fixture() {
  let record: SpecialistSnapshot = { revision: 0, profiles: [profile()] }
  const requests: { path: string; init?: RequestInit }[] = []
  let intercept: ((path: string, init?: RequestInit) => Promise<unknown>) | undefined
  let chats = 0
  const services: SpecialistServices = {
    label: "Test workspace",
    chat: async () => {
      chats++
    },
    request: async <T>(path: string, init?: RequestInit): Promise<T> => {
      requests.push({ path, init })
      if (intercept) return (await intercept(path, init)) as T
      if (path.endsWith("/catalog"))
        return {
          skills: [{ name: "scanpy", description: "Analyze single-cell data" }],
          connectors: [{ name: "pubmed", enabled: true }],
        } as T
      if (init?.method) {
        const body = JSON.parse(String(init.body))
        if (body.revision !== record.revision)
          throw Object.assign(new Error("Changed in another window"), { status: 409 })
        const name = path.split("/").at(-1)
        if (init.method === "POST") record.profiles.push({ ...body.profile, source: "custom", updatedAt: 1 })
        if (init.method === "PUT")
          record.profiles = record.profiles.map((x) => (x.name === name ? { ...x, ...body.profile } : x))
        if (init.method === "PATCH")
          record.profiles = record.profiles.map((x) => (x.name === name ? { ...x, enabled: body.enabled } : x))
        if (init.method === "DELETE") record.profiles = record.profiles.filter((x) => x.name !== name)
        record.revision++
      }
      return structuredClone(record) as T
    },
  }
  let model!: SpecialistsState
  solid.createRoot((dispose) => {
    cleanups.push(dispose)
    model = subject.createSpecialistsState(services)
  })
  return {
    model,
    requests,
    record,
    chats: () => chats,
    intercept: (value?: typeof intercept) => {
      intercept = value
    },
    change: () => record.revision++,
  }
}

test("creates, edits, filters, toggles and deletes profiles through the settings API", async () => {
  const f = fixture()
  await f.model.load()
  f.model.edit()
  f.model.setState("editor", "draft", {
    name: "cell-expert",
    displayName: "Cell expert",
    skillNames: ["scanpy"],
    connectors: [],
  })
  expect(f.model.dirty()).toBe(true)
  await f.model.save()
  expect(f.model.state.editor).toBeUndefined()
  expect(f.model.state.data?.profiles).toHaveLength(2)
  const expert = f.model.state.data!.profiles[1]
  expect(expert.skillNames).toEqual(["scanpy"])
  expect(expert.connectors).toEqual([])
  f.model.setState("filter", "custom")
  expect(f.model.filtered().map((x) => x.name)).toEqual(["cell-expert"])
  f.model.setState("query", "missing")
  expect(f.model.filtered()).toHaveLength(0)
  await f.model.toggle(expert)
  expect(f.model.state.data!.profiles[1].enabled).toBe(false)
  await f.model.remove(expert)
  expect(f.model.state.data?.profiles).toHaveLength(1)
  await f.model.chat()
  expect(f.chats()).toBe(1)
})

test("keeps drafts on conflict and reloads the saved version only when requested", async () => {
  const f = fixture()
  await f.model.load()
  f.model.edit(profile())
  f.model.setState("editor", "draft", "instructions", "Unsaved research requirements")
  f.change()
  await f.model.save()
  expect(f.model.state.conflict).toBe(true)
  expect(f.model.state.editor?.draft.instructions).toBe("Unsaved research requirements")
  expect(f.model.state.editor?.revision).toBe(0)
  await f.model.reloadDraft()
  expect(f.model.state.editor?.draft.instructions).toBe("")
  expect(f.model.state.editor?.revision).toBe(1)
})

test("late reads cannot overwrite a successful write and duplicate submissions are suppressed", async () => {
  const f = fixture()
  await f.model.load()
  let finish!: (value: unknown) => void
  f.intercept(
    async () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = f.model.load()
  f.intercept(undefined)
  f.model.edit()
  f.model.setState("editor", "draft", { name: "latest", displayName: "Latest" })
  const first = f.model.save()
  const second = f.model.save()
  await Promise.all([first, second])
  finish({ revision: 0, profiles: [] })
  await pending
  expect(f.model.state.data?.profiles).toHaveLength(2)
  expect(f.requests.filter((x) => x.init?.method === "POST")).toHaveLength(1)
})

test("validates IDs without sending malformed profiles and preserves independent empty capability lists", async () => {
  const f = fixture()
  await f.model.load()
  f.model.edit()
  f.model.setState("editor", "draft", { name: "../bad", displayName: "专家" })
  await f.model.save()
  expect(f.model.state.mutationError).toContain("Agent ID")
  expect(f.requests.filter((x) => x.init?.method === "POST")).toHaveLength(0)
  expect(subject.specialistID("Single-cell reviewer")).toBe("single-cell-reviewer")
  expect(
    subject.specialistDraft({ name: "reviewer", displayName: "Reviewer", skillNames: [], connectors: [] }),
  ).toMatchObject({ skillNames: [], connectors: [] })
})
