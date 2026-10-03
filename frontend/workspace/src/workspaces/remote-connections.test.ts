import { expect, test } from "bun:test"
import { createRemoteConnections } from "./remote-connections"
import type { RemoteWorkspace } from "./context"

const remote = (state: RemoteWorkspace["state"] = "disconnected", id = "bio"): RemoteWorkspace => ({
  id,
  name: id,
  target: { kind: "ssh", host_id: id },
  projectID: `project-${id}`,
  state,
  progress: state,
})
function fixture() {
  let remotes = [remote(), remote("disconnected", "other")]
  const events: RemoteWorkspace[] = []
  const calls: {
    id: string
    action: string
    result: ReturnType<typeof Promise.withResolvers<RemoteWorkspace | void>>
  }[] = []
  const connections = createRemoteConnections({
    read: () => remotes,
    write: (value) => {
      remotes = value
    },
    request: (id, action) => {
      const result = Promise.withResolvers<RemoteWorkspace | void>()
      calls.push({ id, action, result })
      return result.promise
    },
    settled: (value) => events.push(value),
  })
  const sync = (value: RemoteWorkspace[]) => connections.sync(value, connections.revision())
  return { connections, calls, events, sync, read: () => remotes }
}
const tick = () => Bun.sleep(0)

test("starting gives immediate feedback and repeated clicks share one request", async () => {
  const f = fixture()
  const pending = f.connections.connect("bio")
  expect(f.read()[0].state).toBe("connecting")
  expect(f.connections.connect("bio")).toBe(pending)
  await tick()
  expect(f.calls).toHaveLength(1)
  f.sync([remote()])
  expect(f.read()[0].state).toBe("connecting")
  f.calls[0].result.resolve(remote("connecting"))
  await pending
  f.sync([remote("connected")])
  f.sync([remote("connected")])
  expect(f.events.map((event) => event.state)).toEqual(["connected"])
})

test("a catalog response issued before reconnect cannot roll back its result", async () => {
  const f = fixture()
  const revision = f.connections.revision()
  const pending = f.connections.connect("bio")
  await tick()
  f.calls[0].result.resolve(remote("connecting"))
  await pending
  f.connections.sync([remote()], revision)
  expect(f.read()[0].state).toBe("connecting")
  f.sync([remote("connected")])
  expect(f.read()[0].state).toBe("connected")
})

test("independent projects connect concurrently and each reports its own outcome", async () => {
  const f = fixture()
  const first = f.connections.connect("bio")
  const second = f.connections.connect("other")
  await tick()
  expect(f.calls.map((call) => call.id)).toEqual(["bio", "other"])
  f.calls[0].result.resolve(remote("connecting"))
  f.calls[1].result.resolve(remote("connecting", "other"))
  await Promise.all([first, second])
  f.sync([remote("connected"), { ...remote("error", "other"), error: "SSH timed out" }])
  expect(f.events.map((event) => [event.id, event.state])).toEqual([
    ["bio", "connected"],
    ["other", "error"],
  ])
})

test("request errors remain visible across polling and retry clears them", async () => {
  const f = fixture()
  const pending = f.connections.connect("bio")
  await tick()
  f.calls[0].result.reject(new Error("Local server unavailable"))
  await pending
  f.sync([remote()])
  expect(f.read()[0]).toMatchObject({ state: "error", error: "Local server unavailable" })
  expect(f.events).toHaveLength(1)
  const retry = f.connections.connect("bio")
  expect(f.read()[0].error).toBeUndefined()
  await tick()
  f.calls[1].result.resolve(remote("connecting"))
  await retry
  f.sync([remote("connected")])
  expect(f.events).toHaveLength(2)
})

test("an accepted request with a lost response recovers from backend status", async () => {
  const f = fixture()
  const pending = f.connections.connect("bio")
  await tick()
  f.calls[0].result.reject(new Error("Request timed out"))
  await pending
  f.sync([remote("connecting")])
  expect(f.read()[0].error).toBeUndefined()
  f.sync([remote("connected")])
  expect(f.read()[0].state).toBe("connected")
})

test("cancel waits for an in-flight start and ignores its late success", async () => {
  const f = fixture()
  const start = f.connections.connect("bio")
  await tick()
  const cancel = f.connections.disconnect("bio")
  expect(f.connections.disconnect("bio")).toBe(cancel)
  expect(f.read()[0].progress).toBe("Cancelling connection…")
  f.calls[0].result.resolve(remote("connected"))
  await start
  await tick()
  expect(f.calls.map((call) => call.action)).toEqual(["connect", "disconnect"])
  expect(f.events).toHaveLength(0)
  f.calls[1].result.resolve()
  await cancel
  expect(f.read()[0].state).toBe("disconnected")
  expect(f.events).toHaveLength(0)
})

test("an explicit cancel failure is visible and a backend refresh can recover", async () => {
  const f = fixture()
  f.sync([remote("connecting")])
  const pending = f.connections.disconnect("bio")
  await tick()
  f.calls[0].result.reject(new Error("Cancel request failed"))
  await pending
  expect(f.read()[0].error).toBe("Cancel request failed")
  f.sync([remote("connected")])
  expect(f.read()[0].error).toBeUndefined()
})

test("unmount stops observing without sending a disconnect or applying late responses", async () => {
  const f = fixture()
  const pending = f.connections.connect("bio")
  await tick()
  f.connections.dispose()
  f.calls[0].result.resolve(remote("connected"))
  await pending
  f.sync([remote("connected")])
  expect(f.calls.map((call) => call.action)).toEqual(["connect"])
  expect(f.read()[0].state).toBe("connecting")
  expect(f.events).toHaveLength(0)
})

test("initial status discovery produces no unsolicited notifications", async () => {
  const f = fixture()
  f.sync([remote("connected"), remote("error", "other")])
  await f.connections.connect("bio")
  expect(f.calls).toHaveLength(0)
  expect(f.events).toHaveLength(0)
})
