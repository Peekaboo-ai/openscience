import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../test/vite"
import type { DirectoryListing } from "./context"

const context = `
export const state = { request: async () => ({ hosts: [], configs: [], wsl: [], docker: [] }), fetch: async () => Response.json({}), refresh: async () => {}, opened: [] }
export const useWorkspaces = () => ({
  localUrl: 'http://fixture.invalid',
  remoteBase: id => 'http://fixture.invalid/remote/' + id,
  api: (...args) => state.request(...args),
  fetch: (...args) => state.fetch(...args),
  refresh: () => state.refresh(),
  open: (...args) => state.opened.push(args),
})
`
const vite = await createTestServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  logLevel: "silent",
  plugins: [
    {
      name: "project-dialog-services",
      enforce: "pre",
      resolveId: (id, importer) =>
        importer?.replaceAll("\\", "/").endsWith("/ProjectDialog.tsx") && id === "./context"
          ? "\0project-dialog-services"
          : undefined,
      load: (id) => (id === "\0project-dialog-services" ? context : undefined),
    },
    solid({ ssr: false, dev: false }),
  ],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const solidjs = (await vite.ssrLoadModule("solid-js")) as typeof import("solid-js")
const dialogs = (await vite.ssrLoadModule("@synsci/ui/context/dialog")) as typeof import("@synsci/ui/context/dialog")
const subject = (await vite.ssrLoadModule("/src/workspaces/ProjectDialog.tsx")) as typeof import("./ProjectDialog")
const fixture = (await vite.ssrLoadModule("\0project-dialog-services")) as {
  state: {
    request: (route: string, init?: RequestInit) => Promise<unknown>
    fetch: typeof fetch
    refresh: () => Promise<void>
    opened: string[][]
  }
}
const cleanups: (() => void)[] = []
const ready = async (check: () => boolean) => {
  for (let index = 0; index < 100 && !check(); index++) await Bun.sleep(10)
  expect(check()).toBe(true)
}
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name)!
const path = () => document.querySelector<HTMLInputElement>("#workspace-working-directory")!
const fill = (input: HTMLInputElement, value: string) => {
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
const listing = (directory: string): DirectoryListing => ({ directory, parent: "/", entries: [] })

async function mount() {
  fixture.state.opened = []
  const host = document.createElement("div")
  document.body.append(host)
  const Launch = () => {
    const dialog = dialogs.useDialog()
    solidjs.onMount(() => dialog.show(() => web.createComponent(subject.ProjectDialog, { mode: "local" })))
    return null
  }
  const dispose = web.render(
    () =>
      web.createComponent(dialogs.DialogProvider, {
        get children() {
          return web.createComponent(Launch, {})
        },
      }),
    host,
  )
  cleanups.push(dispose)
  await ready(() => !!path())
  fill(document.querySelector<HTMLInputElement>('input[placeholder="Research project"]')!, "Research")
  return { dispose }
}

afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

test("a manual directory edit cancels a slow browse and cannot be overwritten by its late response", async () => {
  const response = Promise.withResolvers<Response>()
  const signals: AbortSignal[] = []
  fixture.state.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    signals.push(init!.signal!)
    return response.promise
  }) as unknown as typeof fetch
  await mount()
  fill(path(), "/old")
  button("Browse").click()
  await ready(() => signals.length === 1)
  expect(button("Open project").disabled).toBe(true)
  fill(path(), "/new")
  expect(signals[0].aborted).toBe(true)
  response.resolve(Response.json(listing("/old")))
  await Bun.sleep(20)
  expect(path().value).toBe("/new")
  expect(button("Open project").disabled).toBe(false)
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

test("directory browsing blocks submitting an outdated path until the selected directory is available", async () => {
  const response = Promise.withResolvers<Response>()
  const writes: string[] = []
  fixture.state.request = async (route) => {
    if (route !== "/remote-workspaces/options") writes.push(route)
    return { hosts: [], configs: [], wsl: [], docker: [] }
  }
  fixture.state.fetch = (async () => response.promise) as unknown as typeof fetch
  await mount()
  fill(path(), "/parent")
  button("Browse").click()
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  expect(writes).toEqual([])
  response.resolve(Response.json(listing("/resolved")))
  await ready(() => !button("Open project").disabled)
  expect(path().value).toBe("/resolved")
})

for (const close of ["dismiss", "unmount"] as const)
  test(`${close} during saved-project refresh does not navigate away from current work`, async () => {
    const refreshed = Promise.withResolvers<void>()
    let waiting = false
    fixture.state.request = async (route) =>
      route === "/global/project" ? { id: "prj_saved" } : { hosts: [], configs: [], wsl: [], docker: [] }
    fixture.state.refresh = () => {
      waiting = true
      return refreshed.promise
    }
    const mounted = await mount()
    button("Open project").click()
    await ready(() => waiting)
    if (close === "unmount") mounted.dispose()
    else {
      button("Cancel").click()
      await ready(() => path() === null)
    }
    refreshed.resolve()
    await Bun.sleep(20)
    expect(fixture.state.opened).toEqual([])
  })
