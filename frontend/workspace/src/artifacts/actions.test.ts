import { afterAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../test/vite"
import type { StoredArtifact } from "./store"
import type { ArtifactTransport } from "./bytes"

const server = await createTestServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const solidjs = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const subject = (await server.ssrLoadModule("/src/artifacts/actions.ts")) as typeof import("./actions")
afterAll(() => server.close())
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const artifact = (id: string): StoredArtifact => ({
  schemaVersion: 1,
  id,
  projectID: "prj_1",
  title: `${id}.md`,
  kind: "report",
  currentVersionID: `ver_${id}`,
  createdAt: 1,
  updatedAt: 1,
  state: "active",
  versionCount: 1,
  current: {
    id: `ver_${id}`,
    artifactID: id,
    version: 1,
    filename: `${id}.md`,
    mimeType: "text/markdown",
    size: 1,
    sha256: "abc",
    sessionID: "ses_1",
    sourcePath: `/results/${id}.md`,
    captureQuality: "exact",
    createdAt: 1,
  },
})

function setup(request: ArtifactTransport) {
  const events: Array<{ type: string; value: unknown }> = []
  return solidjs.createRoot((dispose) => {
    const [current, setArtifact] = solidjs.createSignal(artifact("art_a"))
    const [scope, setScope] = solidjs.createSignal("server_1/project_1")
    const actions = subject.createStoredArtifactActions({
      artifact: current,
      scope,
      request,
      renamed: (value) => events.push({ type: "rename", value }),
      removed: (value) => events.push({ type: "delete", value }),
      downloaded: (value) => events.push({ type: "download", value }),
      failed: (type, value) => events.push({ type: `${type}-error`, value }),
    })
    return { actions, events, setArtifact, setScope, dispose }
  })
}

describe("saved Result actions", () => {
  test("rename and delete use the selected artifact and report a successful mutation", async () => {
    const calls: Array<{ path: string; method?: string; body: unknown }> = []
    const root = setup(async (path, init) => {
      calls.push({ path, method: init?.method, body: init?.body })
      return Response.json({ ...artifact("art_a"), title: "Renamed" })
    })
    try {
      await root.actions.rename(" Renamed ")
      await root.actions.remove()
      expect(calls).toEqual([
        { path: "/file/artifact-store/art_a", method: "PATCH", body: '{"title":"Renamed"}' },
        { path: "/file/artifact-store/art_a", method: "DELETE", body: undefined },
      ])
      expect(root.events.map((event) => event.type)).toEqual(["rename", "delete"])
      expect(root.events[1].value).toBe("art_a")
      expect(root.actions.state.busy).toBe(false)
    } finally {
      root.dispose()
    }
  })

  test("a late delete cannot close a newly selected Result or unlock its pending rename", async () => {
    const removed = Promise.withResolvers<Response>()
    const renamed = Promise.withResolvers<Response>()
    const root = setup(async (_, init) => (init?.method === "DELETE" ? removed.promise : renamed.promise))
    try {
      const old = root.actions.remove()
      root.setArtifact(artifact("art_b"))
      await settle()
      expect(root.actions.state.busy).toBe(false)
      const current = root.actions.rename("B renamed")
      removed.resolve(Response.json(true))
      await old
      expect(root.events).toEqual([])
      expect(root.actions.state.busy).toBe(true)
      renamed.resolve(Response.json({ ...artifact("art_b"), title: "B renamed" }))
      await current
      expect(root.events.map((event) => event.type)).toEqual(["rename"])
    } finally {
      root.dispose()
    }
  })

  test("returning to the same Result does not revive an obsolete rename", async () => {
    const pending = Promise.withResolvers<Response>()
    const root = setup(() => pending.promise)
    try {
      const old = root.actions.rename("Old title")
      root.setScope("server_2/project_2")
      await settle()
      root.setScope("server_1/project_1")
      await settle()
      pending.resolve(Response.json({ ...artifact("art_a"), title: "Old title" }))
      await old
      expect(root.events).toEqual([])
      expect(root.actions.state.busy).toBe(false)
    } finally {
      root.dispose()
    }
  })

  test("download errors from a closed view do not surface in the next project", async () => {
    const pending = Promise.withResolvers<Response>()
    const root = setup(() => pending.promise)
    const download = root.actions.download(artifact("art_a").current)
    root.dispose()
    pending.reject(new Error("Disconnected"))
    await download
    expect(root.events).toEqual([])
  })

  test("rejects a mismatched rename response and allows retry after a failure", async () => {
    let requests = 0
    const root = setup(async () => Response.json(artifact(++requests === 1 ? "art_b" : "art_a")))
    try {
      await root.actions.rename("renamed")
      expect(root.events[0].type).toBe("rename-error")
      expect(root.actions.state.busy).toBe(false)
      await root.actions.rename("renamed")
      expect(root.events[1].type).toBe("rename")
    } finally {
      root.dispose()
    }
  })
})
