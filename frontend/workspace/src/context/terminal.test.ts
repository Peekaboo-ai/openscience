import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createOpenScienceClient, type Event } from "@synsci/sdk/v2/client"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../test/vite"
import type { Platform } from "./platform"

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
const reactive = (await vite.ssrLoadModule("solid-js")) as typeof import("solid-js")
const events = (await vite.ssrLoadModule("@solid-primitives/event-bus")) as typeof import("@solid-primitives/event-bus")
const subject = (await vite.ssrLoadModule("/src/context/terminal.tsx")) as typeof import("./terminal")
const platform = (await vite.ssrLoadModule("/src/context/platform.tsx")) as typeof import("./platform")
const cleanups: (() => void)[] = []

afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)
afterAll(() => vite.close())

async function mount() {
  const removed: string[] = []
  const creates: { input: unknown; response: PromiseWithResolvers<Response> }[] = []
  const session = { id: "session" }
  const client = createOpenScienceClient({
    baseUrl: "http://terminal.test",
    throwOnError: true,
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.method === "DELETE") {
        removed.push(new URL(request.url).pathname.split("/").at(-1)!)
        return Response.json(true)
      }
      if (request.method === "POST") {
        const response = Promise.withResolvers<Response>()
        creates.push({ input: await request.json(), response })
        return response.promise
      }
      return Response.json([
        { id: "one", title: "Terminal 1", sessionID: "session", status: "running" },
        { id: "two", title: "Terminal 2", sessionID: "session", status: "running" },
      ])
    }) as typeof fetch,
  })
  const event = events.createGlobalEmitter<{ [key in Event["type"]]: Extract<Event, { type: key }> }>()
  const host = document.createElement("div")
  document.body.append(host)
  let terminal!: ReturnType<typeof subject.createProjectTerminalSession>
  const value: Platform = {
    platform: "web",
    openLink() {},
    restart: async () => {},
    back() {},
    forward() {},
    notify: async () => {},
  }
  const dispose = web.render(
    () =>
      platform.PlatformProvider({
        value,
        get children() {
          return reactive.createComponent(() => {
            terminal = subject.createProjectTerminalSession({ client, event }, crypto.randomUUID(), () => session.id)
            return null
          }, {})
        },
      }),
    host,
  )
  cleanups.push(() => {
    dispose()
    host.remove()
  })
  const ready = async (check: () => boolean) => {
    for (let index = 0; !check() && index < 200; index++) await Bun.sleep(5)
    expect(check()).toBe(true)
  }
  await ready(() => terminal.ready())
  return { terminal, removed, creates, session, ready }
}

test("reconnecting replaces the tab and closes the original process, keeping the replacement alive", async () => {
  const f = await mount()
  f.terminal.open("one")
  const pending = f.terminal.clone("one")
  await f.ready(() => f.creates.length === 1)
  f.creates[0].response.resolve(Response.json({ id: "replacement", title: "Terminal 1", sessionID: "session" }))
  expect((await pending)?.id).toBe("replacement")
  expect(f.terminal.all().map((pty) => pty.id)).toEqual(["replacement", "two"])
  expect(f.terminal.active()).toBe("replacement")
  expect(f.removed).toEqual(["one"])
})

test("reconnecting follows terminal identity when tabs move while the server responds", async () => {
  const f = await mount()
  f.terminal.open("two")
  const pending = f.terminal.clone("one")
  await f.ready(() => f.creates.length === 1)
  f.terminal.move("one", 1)
  f.creates[0].response.resolve(Response.json({ id: "replacement", title: "Terminal 1" }))
  await pending
  expect(f.terminal.all().map((pty) => pty.id)).toEqual(["two", "replacement"])
  expect(f.terminal.active()).toBe("two")
  expect(f.removed).toEqual(["one"])
})

test("closing a tab during reconnect disposes the late replacement and preserves other tabs", async () => {
  const f = await mount()
  const pending = f.terminal.clone("one")
  await f.ready(() => f.creates.length === 1)
  await f.terminal.close("one")
  f.creates[0].response.resolve(Response.json({ id: "replacement", title: "Terminal 1" }))
  expect(await pending).toBeUndefined()
  expect(f.terminal.all().map((pty) => pty.id)).toEqual(["two"])
  expect(f.terminal.active()).toBe("two")
  expect(f.removed).toEqual(["one", "replacement"])
})

test("overlapping reconnects keep one replacement and clean up the late process", async () => {
  const f = await mount()
  const first = f.terminal.clone("one")
  const second = f.terminal.clone("one")
  await f.ready(() => f.creates.length === 2)
  f.creates[0].response.resolve(Response.json({ id: "replacement", title: "Terminal 1" }))
  await first
  f.creates[1].response.resolve(Response.json({ id: "late", title: "Terminal 1" }))
  expect(await second).toBeUndefined()
  expect(f.terminal.all().map((pty) => pty.id)).toEqual(["replacement", "two"])
  expect(f.removed).toEqual(["one", "late"])
})
