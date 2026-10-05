import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"
import type { MemoryStore } from "./memory-state"
import type { MemoryWorkspaces } from "./memory-workspaces"

const directory = await mkdtemp(path.join(os.tmpdir(), "onelab-memory-ui-"))
async function start(name: string) {
  const root = path.join(directory, name)
  await mkdir(path.join(root, "home"), { recursive: true })
  const child = Bun.spawn([process.execPath, "test/fixture/memory-server.ts"], {
    cwd: fileURLToPath(new URL("../../../../../backend/cli", import.meta.url)),
    env: {
      ...process.env,
      OPENSCIENCE_DATA_DIR: path.join(root, "data"),
      OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "share"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      OPENSCIENCE_TEST_HOME: path.join(root, "home"),
      OPENSCIENCE_DISABLE_MODELS_FETCH: "true",
      OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const startup = async () => {
    const reader = child.stdout.getReader()
    let text = ""
    for (;;) {
      const next = await reader.read()
      if (next.done) throw new Error(`Memory fixture exited: ${await new Response(child.stderr).text()}`)
      text += new TextDecoder().decode(next.value)
      const match = text.match(/MEMORY_TEST_READY:(.+)\r?\n/)
      if (match) {
        reader.releaseLock()
        return JSON.parse(match[1]) as { url: string; filepath: string }
      }
    }
  }
  const timer = setTimeout(() => child.kill(), 15_000)
  return { ...(await startup().finally(() => clearTimeout(timer))), child }
}
const [backend, remoteBackend] = await Promise.all([start("local"), start("remote")])
const vite = await createTestServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await vite.ssrLoadModule("/src/components/settings/Memory.tsx")) as typeof import("./Memory")
const stores = (await vite.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const cleanups: (() => void)[] = []
const ready = async (check: () => boolean) => {
  for (let i = 0; i < 150 && !check(); i++) await Bun.sleep(20)
  expect(check()).toBe(true)
}
const current = async (base = backend.url) => (await (await fetch(`${base}/settings/memory`)).json()) as MemoryStore
const mutate = async (route: string, body: Record<string, unknown>, method = "POST", base = backend.url) => {
  const result = await fetch(`${base}/settings/memory${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: (await current(base)).revision, ...body }),
  })
  expect(result.ok).toBe(true)
  return (await result.json()) as MemoryStore
}
async function mount(withWorkspaces = false) {
  const old = await current()
  if (old.notes.length) await mutate("/notes/delete", { ids: old.notes.map((x) => x.id) })
  await mutate("", { enabled: true }, "PATCH")
  const note = { title: "Language", content: "Write in Chinese.", categoryID: "about-you", scope: { kind: "global" } }
  await mutate("/notes", { note })
  const state: {
    reject: boolean
    reads: number
    requests: string[]
    connections: string[]
    hold?: { received: () => void; release: Promise<void> }
    holdCatalog?: { received: () => void; release: Promise<void> }
  } = {
    reject: false,
    reads: 0,
    requests: [],
    connections: [],
  }
  const [workspace, setWorkspace] = stores.createStore<MemoryWorkspaces["state"]>({
    projects: [
      {
        id: "prj_alpha",
        name: "Enzyme research",
        worktree: "/enzyme",
        sandboxes: [],
        time: { created: 1, updated: 1 },
      },
      {
        id: "prj_archived",
        name: "Archived validation",
        worktree: "/old",
        sandboxes: [],
        time: { created: 1, updated: 1, archived: 1 },
      },
    ],
    remotes: [
      {
        id: "bio",
        name: "Bio",
        projectID: "prj_beta",
        target: { kind: "ssh", host_id: "host-bio" },
        state: "connected",
        progress: "",
      },
      { id: "bio1", name: "Bio1", target: { kind: "ssh", host_id: "host-bio1" }, state: "disconnected", progress: "" },
    ],
    tasksProjectID: "prj_alpha",
    ready: true,
    selected: "",
    error: "",
    mobileOpen: false,
  })
  const workspaces: MemoryWorkspaces = {
    state: workspace,
    localUrl: backend.url,
    remoteBase: () => remoteBackend.url,
    refresh: async () => {},
    connect: async (id) => {
      state.connections.push(id)
      setWorkspace("remotes", (remote) => remote.id === id, { state: "connecting" })
      await Promise.resolve()
      setWorkspace("remotes", (remote) => remote.id === id, { state: "connected", projectID: "prj_alpha" })
    },
  }
  if (withWorkspaces) {
    const old = await current(remoteBackend.url)
    if (old.notes.length)
      await mutate("/notes/delete", { ids: old.notes.map((note) => note.id) }, "POST", remoteBackend.url)
    await mutate(
      "/notes",
      { note: { ...note, title: "Remote convention", content: "Use the remote scheduler." } },
      "POST",
      remoteBackend.url,
    )
  }
  const [sdk, setSDK] = stores.createStore({ url: backend.url })
  const request: typeof fetch = Object.assign(
    async (...[input, init]: Parameters<typeof fetch>) => {
      state.reads++
      state.requests.push(String(input))
      if (state.reject) return Response.json({ message: "Test connection unavailable" }, { status: 503 })
      const response = await fetch(input, init)
      if (state.holdCatalog && String(input).startsWith(remoteBackend.url) && String(input).includes("/catalog")) {
        const held = state.holdCatalog
        held.received()
        await held.release
      }
      if (state.hold && init?.method === "POST") {
        const held = state.hold
        held.received()
        await held.release
      }
      return response
    },
    { preconnect: fetch.preconnect },
  )
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(
    () =>
      subject.Memory({
        services: {
          sdk,
          platform: { fetch: request },
          label: "Isolated memory server",
          pathname: "/prj_alpha/session/ses_alpha",
          workspaces: withWorkspaces ? workspaces : undefined,
        },
      }),
    host,
  )
  cleanups.push(dispose)
  await ready(() => host.textContent?.includes("1 included") ?? false)
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent === text)!
  const fill = (label: string, value: string) => {
    const field = [...host.querySelectorAll("label")]
      .find((x) => x.textContent?.startsWith(label))
      ?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")
    expect(field).toBeDefined()
    field!.value = value
    field!.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const select = (label: string, value: string) => {
    const field = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
    field.value = value
    field.dispatchEvent(new Event("change", { bubbles: true }))
  }
  const submit = () =>
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  return { host, state, button, fill, select, submit, setSDK, setWorkspace }
}
afterEach(() => {
  cleanups.splice(0).forEach((x) => x())
  document.body.replaceChildren()
})
afterAll(async () => {
  await vite.close()
  backend.child.kill()
  remoteBackend.child.kill()
  await Promise.all([backend.child.exited, remoteBackend.child.exited])
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test("creates session memory through the real API, recalls it and clears only direct notes", async () => {
  const { host, button, fill, submit } = await mount()
  expect(host.textContent).toContain("Inherited")
  button("Add memory").click()
  fill("Title", "Report convention")
  fill("What should OneLab remember?", "Include uncertainty intervals.")
  submit()
  await ready(() => host.querySelector("form") === null)
  const saved = (await current()).notes.find((x) => x.title === "Report convention")!
  expect(saved.scope).toEqual({ kind: "session", projectID: "prj_alpha", sessionID: "ses_alpha" })
  await ready(() => host.textContent?.includes("2 included") ?? false)
  button("Clear notes in this scope").click()
  button("Delete permanently").click()
  await ready(() => host.querySelector('[role="alertdialog"]') === null)
  expect((await current()).notes.map((x) => x.title)).toEqual(["Language"])
})

test("conflicting edits preserve a draft and can be retried after refresh", async () => {
  const { host, fill, submit } = await mount()
  host.querySelector<HTMLButtonElement>('[aria-label="Edit memory Language"]')!.click()
  fill("What should OneLab remember?", "Use concise Chinese.")
  await mutate("", { enabled: false }, "PATCH")
  host.querySelector<HTMLButtonElement>('[aria-label="Refresh memory"]')!.click()
  await ready(() => host.textContent?.includes("Paused") ?? false)
  submit()
  await ready(() => host.textContent?.includes("changed in another window") ?? false)
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Use concise Chinese.")
  await ready(() => !host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled)
  submit()
  await ready(() => host.querySelector("form") === null)
  expect((await current()).notes[0].content).toBe("Use concise Chinese.")
})

test("category creation, auto-recall, search and project switches update the visible context", async () => {
  const { host, button, fill, submit, select } = await mount()
  host.querySelector<HTMLButtonElement>(".memory-category-add")!.click()
  fill("Name", "Lab notes")
  fill("What belongs in this category?", "Repeatable research practices.")
  submit()
  await ready(() => host.querySelector("form") === null)
  const category = (await current()).categories.find((x) => x.name === "Lab notes")!
  await mutate("/notes", {
    note: {
      title: "Analysis units",
      content: "Use SI.",
      categoryID: category.id,
      scope: { kind: "project", projectID: "prj_alpha" },
    },
  })
  host.querySelector<HTMLButtonElement>('[aria-label="Refresh memory"]')!.click()
  await ready(() => host.textContent?.includes("Analysis units") ?? false)
  const categoryButton = [...host.querySelectorAll<HTMLButtonElement>(".memory-categories button")].find((x) =>
    x.textContent?.includes("Lab notes"),
  )!
  categoryButton.click()
  host.querySelector<HTMLInputElement>('.memory-category-controls input[role="switch"]')!.click()
  await ready(() => host.textContent?.includes("Auto-recall is off") ?? false)
  expect((await current()).categories.find((x) => x.id === category.id)?.autoRecall).toBe(false)
  const search = host.querySelector<HTMLInputElement>('[aria-label="Search memories…"]')!
  search.value = "units"
  search.dispatchEvent(new Event("input", { bubbles: true }))
  expect(host.querySelectorAll(".memory-note")).toHaveLength(1)
  select("View memory scope", "project")
  select("Memory project", "prj_beta")
  await ready(() => host.textContent?.includes("No matching memories") ?? false)
  expect(host.querySelectorAll(".memory-note")).toHaveLength(0)
})

test("category navigation stays usable and preserves every field of an unfinished memory", async () => {
  const { host, button, fill, select } = await mount()
  const category = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>(".memory-categories button")].find((item) =>
      item.textContent?.includes(name),
    )!
  button("Add memory").click()
  expect(category("About you").disabled).toBe(false)
  category("About you").click()
  expect(host.querySelector("form")).toBeNull()
  expect(category("About you").getAttribute("aria-current")).toBe("true")
  expect(host.querySelector(".memory-draft")).toBeNull()
  button("Add memory").click()
  fill("Title", "Keep this draft")
  fill("What should OneLab remember?", "Record seeds and uncertainty.")
  select("Memory category", "cautions")
  const expires = host.querySelector<HTMLInputElement>('[aria-label="Memory expiration"]')!
  expires.value = "2030-10-15T23:30"
  expires.dispatchEvent(new Event("input", { bubbles: true }))
  for (const name of ["Cautions", "Research preferences", "All categories"]) {
    expect(category(name).disabled).toBe(false)
    category(name).click()
    expect(host.querySelector("form")).toBeNull()
    expect(category(name).getAttribute("aria-current")).toBe("true")
    expect(host.querySelector(".memory-draft")?.textContent).toContain("Keep this draft")
    button("Resume editing").click()
    expect(host.querySelector<HTMLInputElement>("form input")?.value).toBe("Keep this draft")
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Record seeds and uncertainty.")
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Memory category"]')?.value).toBe("cautions")
    expect(host.querySelector<HTMLInputElement>('[aria-label="Memory expiration"]')?.value).toBe("2030-10-15T23:30")
  }
  select("View memory scope", "global")
  expect(host.querySelector("form")).toBeNull()
  button("Resume editing").click()
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Memory scope"]')?.value).toBe(
    "session:prj_alpha:ses_alpha",
  )
})

test.each(["global", "project:prj_alpha"])(
  "changing Save in to %s removes incompatible scope fields before saving",
  async (scope) => {
    const { host, button, fill, select, submit } = await mount()
    button("Add memory").click()
    fill("Title", "Strict scope")
    fill("What should OneLab remember?", "Use the selected scope only.")
    select("Memory scope", scope)
    submit()
    await ready(() => host.querySelector("form") === null)
    const saved = (await current()).notes.find((note) => note.title === "Strict scope")!
    expect(saved.scope).toEqual(scope === "global" ? { kind: "global" } : { kind: "project", projectID: "prj_alpha" })
  },
)

test("opening another editor offers explicit draft recovery instead of blocking navigation", async () => {
  const { host, button, fill } = await mount()
  button("Add memory").click()
  fill("Title", "Unfinished analysis")
  host.querySelector<HTMLButtonElement>(".memory-category-add")!.click()
  expect(host.querySelector('[aria-label="Unsaved memory draft"]')).not.toBeNull()
  button("Keep editing").click()
  expect(host.querySelector<HTMLInputElement>("form input")?.value).toBe("Unfinished analysis")
  host.querySelector<HTMLButtonElement>(".memory-category-add")!.click()
  button("Discard and continue").click()
  expect(host.querySelector('form[aria-label="Category editor"]')).not.toBeNull()
  expect(host.querySelector<HTMLInputElement>("form input")?.value).toBe("")
  expect(host.querySelector('[aria-label="Unsaved memory draft"]')).toBeNull()
})

test("failed saves unlock navigation and preserve a draft for retry", async () => {
  const { host, state, button, fill, submit } = await mount()
  button("Add memory").click()
  fill("Title", "Retry safely")
  fill("What should OneLab remember?", "Preserve this content.")
  state.reject = true
  submit()
  await ready(() => host.textContent?.includes("Test connection unavailable") ?? false)
  await ready(() => !host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled)
  const all = host.querySelector<HTMLButtonElement>(".memory-categories button")!
  expect(all.disabled).toBe(false)
  all.click()
  expect(host.querySelector("form")).toBeNull()
  button("Resume editing").click()
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Preserve this content.")
  state.reject = false
  submit()
  await ready(() => host.querySelector("form") === null)
  expect((await current()).notes.find((note) => note.title === "Retry safely")?.content).toBe("Preserve this content.")
})

test("replacing an edited category opens a fresh editor and never overwrites the original category", async () => {
  const { host, button, fill, submit } = await mount()
  const original = (await current()).categories.find((item) => item.id === "about-you")!
  const category = [...host.querySelectorAll<HTMLButtonElement>(".memory-categories button")].find((item) =>
    item.textContent?.includes("About you"),
  )!
  category.click()
  host.querySelector<HTMLButtonElement>('[aria-label="Edit category"]')!.click()
  fill("Name", "Do not overwrite")
  host.querySelector<HTMLButtonElement>(".memory-category-add")!.click()
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
  button("Discard and continue").click()
  expect(host.querySelector("form h3")?.textContent).toBe("New category")
  fill("Name", "Fresh taxonomy")
  submit()
  await ready(() => host.querySelector("form") === null)
  const saved = await current()
  expect(saved.categories.find((item) => item.id === "about-you")).toEqual(original)
  expect(saved.categories.find((item) => item.name === "Fresh taxonomy")?.id).not.toBe("about-you")
})

test("a remote reconnect restores the typed form and switching projects keeps drafts on their source", async () => {
  const { host, select, button, fill, setWorkspace } = await mount(true)
  button("Add memory").click()
  fill("Title", "Local draft")
  fill("What should OneLab remember?", "Local context only.")
  select("Memory project", "remote:bio")
  await ready(() =>
    [...host.querySelector<HTMLSelectElement>('[aria-label="Memory session"]')!.options].some(
      (x) => x.value === "ses_beta",
    ),
  )
  select("Memory session", "ses_beta")
  await ready(() => host.textContent?.includes("Use the remote scheduler.") ?? false)
  expect(host.textContent).not.toContain("Local draft")
  button("Add memory").click()
  fill("Title", "Remote draft")
  fill("What should OneLab remember?", "Keep the allocation details.")
  select("Memory category", "cautions")
  setWorkspace("remotes", (remote) => remote.id === "bio", "state", "connecting")
  await ready(() => host.querySelector(".memory-library") === null)
  setWorkspace("remotes", (remote) => remote.id === "bio", "state", "connected")
  await ready(() => host.querySelector<HTMLInputElement>("form input")?.value === "Remote draft")
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Keep the allocation details.")
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Memory category"]')?.value).toBe("cautions")
  select("Memory project", "prj_alpha")
  await ready(() => host.querySelector(".memory-draft")?.textContent?.includes("Local draft") ?? false)
  expect(host.textContent).not.toContain("Remote draft")
  button("Resume editing").click()
  expect(host.querySelector<HTMLInputElement>("form input")?.value).toBe("Local draft")
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Memory scope"]')?.value).toBe(
    "session:prj_alpha:ses_alpha",
  )
  select("Memory project", "remote:bio")
  await ready(() => host.querySelector(".memory-draft")?.textContent?.includes("Remote draft") ?? false)
})

test("failed refresh retains notes while switching servers clears private data and drafts", async () => {
  const { host, state, setSDK } = await mount()
  state.reject = true
  host.querySelector<HTMLButtonElement>('[aria-label="Refresh memory"]')!.click()
  await ready(() => host.querySelector('[role="alert"]') !== null)
  expect(host.textContent).toContain("Write in Chinese.")
  setSDK("url", `${backend.url}/another-server`)
  await ready(() => !host.textContent?.includes("Write in Chinese."))
  expect(host.querySelector(".memory-library")).toBeNull()
})

test("a delayed save cannot overwrite fresh data after switching away and back to the same server", async () => {
  const { host, state, setSDK, button, fill, submit } = await mount()
  const received = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  state.hold = { received: received.resolve, release: release.promise }
  try {
    button("Add memory").click()
    fill("Title", "Delayed note")
    fill("What should OneLab remember?", "Wait for the response.")
    submit()
    await received.promise
    state.reject = true
    setSDK("url", `${backend.url}/another-server`)
    await ready(() => host.querySelector(".memory-library") === null)
    state.reject = false
    setSDK("url", backend.url)
    await ready(() => host.textContent?.includes("2 included") ?? false)
    await mutate("/notes", {
      note: {
        title: "Newer note",
        content: "Keep this latest update.",
        categoryID: "about-you",
        scope: { kind: "global" },
      },
    })
    host.querySelector<HTMLButtonElement>('[aria-label="Refresh memory"]')!.click()
    await ready(() => host.textContent?.includes("Newer note") ?? false)
    release.resolve()
    await Bun.sleep(50)
    expect(host.textContent).toContain("Newer note")
    expect(host.textContent).not.toContain("Memory saved. It will be considered")
  } finally {
    release.resolve()
  }
})

test("uses workspace projects and saves remote session memory only on its owning server", async () => {
  const { host, select, button, fill, submit } = await mount(true)
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Memory session"]')!.value).toBe("ses_alpha")
  const projects = host.querySelector<HTMLSelectElement>('[aria-label="Memory project"]')!
  expect([...projects.options].map((option) => option.value)).toEqual(["", "prj_alpha", "remote:bio", "remote:bio1"])
  expect(projects.textContent).not.toContain("Materials")
  expect(projects.textContent).not.toContain("Archived validation")
  select("Memory project", "remote:bio")
  const sessions = host.querySelector<HTMLSelectElement>('[aria-label="Memory session"]')!
  await ready(() => [...sessions.options].some((option) => option.value === "ses_beta"))
  expect([...sessions.options].some((option) => option.value === "ses_alpha")).toBe(false)
  select("Memory session", "ses_beta")
  await ready(() => host.textContent?.includes("Use the remote scheduler.") ?? false)
  expect(host.textContent).not.toContain("Write in Chinese.")
  button("Add memory").click()
  fill("Title", "Remote analysis")
  fill("What should OneLab remember?", "Use reproducible cluster jobs.")
  submit()
  await ready(() => host.querySelector("form") === null)
  const note = (await current(remoteBackend.url)).notes.find((note) => note.title === "Remote analysis")!
  expect(note.scope).toEqual({ kind: "session", projectID: "prj_beta", sessionID: "ses_beta" })
  expect((await current()).notes.some((note) => note.title === "Remote analysis")).toBe(false)
  select("Memory project", "prj_alpha")
  select("View memory scope", "project")
  await ready(() => host.textContent?.includes("Write in Chinese.") ?? false)
  expect(host.textContent).not.toContain("Use the remote scheduler.")
  select("View memory scope", "global")
  select("Memory server", "bio")
  await ready(() => host.textContent?.includes("Use the remote scheduler.") ?? false)
})

test("keeps disconnected projects selectable without reading local memory and resolves scope after connecting", async () => {
  const { host, state, select, button } = await mount(true)
  const count = state.requests.length
  select("Memory project", "remote:bio1")
  await ready(() => host.querySelector(".memory-connection") !== null)
  expect(host.querySelector(".memory-library")).toBeNull()
  expect(host.textContent).not.toContain("Write in Chinese.")
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Memory project"]')!.disabled).toBe(false)
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Memory session"]')!.disabled).toBe(true)
  await Bun.sleep(30)
  expect(state.requests).toHaveLength(count)
  button("Connect").click()
  expect(state.connections).toEqual(["bio1"])
  await ready(() => !host.querySelector<HTMLSelectElement>('[aria-label="Memory session"]')!.disabled)
  const sessions = host.querySelector<HTMLSelectElement>('[aria-label="Memory session"]')!
  expect([...sessions.options].some((option) => option.value === "ses_alpha")).toBe(true)
  select("Memory session", "ses_alpha")
  await ready(() => host.textContent?.includes("Use the remote scheduler.") ?? false)
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Memory project"]')!.value).toBe("remote:bio1")
})

test("discards a late remote catalog after the user returns to a local project", async () => {
  const { host, state, select } = await mount(true)
  const received = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  state.holdCatalog = { received: received.resolve, release: release.promise }
  try {
    select("Memory project", "remote:bio")
    await received.promise
    select("Memory project", "prj_alpha")
    const sessions = host.querySelector<HTMLSelectElement>('[aria-label="Memory session"]')!
    await ready(() => [...sessions.options].some((option) => option.value === "ses_alpha"))
    release.resolve()
    await Bun.sleep(30)
    expect([...sessions.options].some((option) => option.value === "ses_beta")).toBe(false)
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Memory project"]')!.value).toBe("prj_alpha")
    select("Memory session", "ses_alpha")
    await ready(() => host.textContent?.includes("Write in Chinese.") ?? false)
    expect(host.textContent).toContain("Write in Chinese.")
  } finally {
    release.resolve()
  }
})
