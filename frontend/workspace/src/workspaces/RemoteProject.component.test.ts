import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../test/vite"
import type { RemoteWorkspace } from "./context"

const vite = await createTestServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const stores = (await vite.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const subject = (await vite.ssrLoadModule("/src/workspaces/RemoteProject.tsx")) as typeof import("./RemoteProject")
const controller = (await vite.ssrLoadModule(
  "/src/workspaces/remote-connections.ts",
)) as typeof import("./remote-connections")
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
afterAll(() => vite.close())

function mount() {
  const [state, setState] = stores.createStore({
    remotes: [
      {
        id: "bio",
        name: "Bio",
        target: { kind: "ssh", host_id: "ssh" },
        projectID: "project",
        state: "disconnected",
        progress: "Disconnected",
      },
    ] as RemoteWorkspace[],
    expanded: false,
  })
  const response = Promise.withResolvers<RemoteWorkspace | void>()
  const calls: string[] = []
  const opened: string[] = []
  const connections = controller.createRemoteConnections({
    read: () => state.remotes,
    write: (remotes) => setState("remotes", stores.reconcile(remotes)),
    request: async (_id, action) => {
      calls.push(action)
      return response.promise
    },
    settled: () => {},
  })
  const host = document.createElement("div")
  document.body.append(host)
  const draft = document.createElement("textarea")
  draft.value = "Continue the local research task"
  host.append(draft)
  const row = document.createElement("div")
  host.append(row)
  const render = () =>
    web.render(
      () =>
        subject.RemoteProject({
          get remote() {
            return state.remotes[0]
          },
          active: false,
          get expanded() {
            return state.expanded
          },
          onToggle: () => setState("expanded", !state.expanded),
          onOpen: () => opened.push("bio"),
          onConnect: () => {
            void connections.connect("bio")
          },
          onDisconnect: () => {
            void connections.disconnect("bio")
          },
          onRemove: () => {},
          onNewConversation: () => {},
        }),
      row,
    )
  let dispose = render()
  cleanups.push(() => {
    dispose()
    connections.dispose()
    host.remove()
  })
  const button = (name: string) => {
    const element = row.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
    if (!element) throw new Error(`Missing button: ${name}`)
    return element
  }
  return {
    state,
    connections,
    response,
    calls,
    opened,
    draft,
    row,
    button,
    remount: () => {
      dispose()
      dispose = render()
    },
    sync: (patch: Partial<RemoteWorkspace>) =>
      connections.sync([{ ...state.remotes[0], ...patch }], connections.revision()),
  }
}

test("sidebar reconnect is nonmodal, disables repeated clicks, and survives row remount", async () => {
  const f = mount()
  f.button("Connect to Bio").click()
  const pending = f.connections.connect("bio")
  await Bun.sleep(0)
  expect(f.button("Connecting to Bio").disabled).toBe(true)
  f.button("Connecting to Bio").click()
  f.draft.focus()
  f.draft.value += " while SSH connects"
  f.remount()
  expect(f.calls).toEqual(["connect"])
  expect(f.row.querySelector('[role="dialog"]')).toBeNull()
  expect(f.draft.value).toEndWith("while SSH connects")
  expect(f.opened).toEqual([])
  f.response.resolve({ ...f.state.remotes[0], state: "connecting" })
  await pending
  f.sync({ state: "connected", progress: "Connected" })
  expect(f.row.textContent).toContain("Connected")
  expect(f.row.querySelector(".workspace-reconnect")).toBeNull()
  expect(f.opened).toEqual([])
  f.row.querySelector<HTMLButtonElement>(".workspace-row-main")!.click()
  expect(f.opened).toEqual(["bio"])
})

test("failures retain a retry button and keyboard-activatable error details", () => {
  const f = mount()
  f.sync({ state: "error", error: "SSH authentication failed", progress: "Connection failed" })
  expect(f.button("Retry connection to Bio").disabled).toBe(false)
  const details = f.button("Connection details for Bio")
  expect(details.getAttribute("aria-expanded")).toBe("false")
  details.focus()
  details.click()
  expect(document.activeElement).toBe(details)
  expect(details.getAttribute("aria-expanded")).toBe("true")
  expect(f.row.querySelector("#remote-status-bio")?.textContent).toContain("SSH authentication failed")
  details.click()
  expect(f.row.querySelector("#remote-status-bio")).toBeNull()
  f.button("Toggle Bio").click()
  expect(details.getAttribute("aria-expanded")).toBe("true")
  details.click()
  expect(f.row.querySelector("#remote-status-bio")).toBeNull()
})

test("expanded connecting rows explain background work and show backend progress", () => {
  const f = mount()
  f.sync({ state: "connecting", progress: "Installing remote backend…" })
  f.button("Toggle Bio").click()
  expect(f.row.textContent).toContain("Installing remote backend…")
  expect(f.row.textContent).toContain("You can continue working while this connects.")
  expect(f.button("Connecting to Bio").getAttribute("aria-busy")).toBe("true")
})
