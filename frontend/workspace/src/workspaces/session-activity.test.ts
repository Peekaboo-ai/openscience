import { afterAll, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../test/vite"
import type { GlobalEvent, SessionStatus } from "@synsci/sdk/v2/client"

const vite = await createTestServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const { createSessionActivity } = (await vite.ssrLoadModule(
  "/src/workspaces/session-activity.ts",
)) as typeof import("./session-activity")
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const { ConversationStatus } = (await vite.ssrLoadModule(
  "/src/workspaces/ConversationStatus.tsx",
)) as typeof import("./ConversationStatus")
afterAll(() => vite.close())
const local = { base: "http://local", projectID: "project", directory: "/work" }
const remote = { ...local, base: "http://local/remote/bio" }
const event = (status: SessionStatus["type"], sessionID = "ses_one"): GlobalEvent => ({
  directory: local.directory,
  payload: {
    type: "session.status",
    properties: {
      sessionID,
      status: status === "retry" ? { type: status, attempt: 1, next: 0, message: "Retry" } : { type: status },
    },
  },
})

test("running, retry and compaction become one unread completion, cleared on view", () => {
  const activity = createSessionActivity()
  for (const type of ["busy", "retry", "compacting"] as const) {
    activity.event(local.base, event(type))
    expect(activity.get(local.base, "ses_one")?.status).toBe(type)
    expect(activity.get(local.base, "ses_one")?.completed).toBeUndefined()
  }
  activity.event(local.base, event("idle"))
  const completed = activity.get(local.base, "ses_one")?.completed
  expect(completed).toBeGreaterThan(0)
  activity.event(local.base, {
    directory: local.directory,
    payload: { type: "session.idle", properties: { sessionID: "ses_one" } },
  })
  expect(activity.get(local.base, "ses_one")?.completed).toBe(completed)
  activity.view(local.base, "ses_one")
  expect(activity.get(local.base, "ses_one")?.completed).toBeUndefined()
})

test("historical idle sessions and currently viewed completions do not become unread", () => {
  const activity = createSessionActivity()
  activity.event(local.base, event("idle"))
  expect(activity.get(local.base, "ses_one")?.completed).toBeUndefined()
  activity.view(local.base, "ses_one")
  activity.event(local.base, event("busy"))
  activity.event(local.base, event("idle"))
  expect(activity.get(local.base, "ses_one")?.completed).toBeUndefined()
  activity.view(local.base)
  activity.event(local.base, event("busy"))
  activity.event(local.base, event("idle"))
  expect(activity.get(local.base, "ses_one")?.completed).toBeGreaterThan(0)
})

test("local and remote sessions remain independent when switching projects", () => {
  const activity = createSessionActivity()
  activity.view(local.base, "ses_one")
  activity.event(local.base, event("busy"))
  activity.event(remote.base, event("busy"))
  activity.event(remote.base, event("idle"))
  expect(activity.get(local.base, "ses_one")?.status).toBe("busy")
  expect(activity.get(remote.base, "ses_one")?.completed).toBeGreaterThan(0)
  activity.view(remote.base, "ses_one")
  activity.event(local.base, event("idle"))
  expect(activity.get(local.base, "ses_one")?.completed).toBeGreaterThan(0)
})

test("initial snapshot finds running work; a valid reconnect snapshot recovers a missed completion", () => {
  const activity = createSessionActivity()
  activity.snapshot(local, { ses_one: { type: "busy" } }, activity.revision())
  expect(activity.get(local.base, "ses_one")?.status).toBe("busy")
  activity.snapshot({ ...local, directory: "/other" }, {}, activity.revision())
  expect(activity.get(local.base, "ses_one")?.status).toBe("busy")
  activity.snapshot(local, {}, activity.revision())
  expect(activity.get(local.base, "ses_one")?.completed).toBeGreaterThan(0)
})

test("late status snapshots cannot override newer start or completion events", () => {
  const activity = createSessionActivity()
  const beforeStart = activity.revision()
  activity.event(local.base, event("busy"))
  activity.snapshot(local, {}, beforeStart)
  expect(activity.get(local.base, "ses_one")?.status).toBe("busy")
  const beforeEnd = activity.revision()
  activity.event(local.base, event("idle"))
  activity.snapshot(local, { ses_one: { type: "busy" } }, beforeEnd)
  expect(activity.get(local.base, "ses_one")?.status).toBe("idle")
  expect(activity.get(local.base, "ses_one")?.completed).toBeGreaterThan(0)
})

test("failed, cancelled and disposed runs do not show a successful completion", () => {
  const activity = createSessionActivity()
  activity.event(local.base, event("busy"))
  activity.event(local.base, {
    directory: local.directory,
    payload: {
      type: "session.error",
      properties: { sessionID: "ses_one", error: { name: "MessageAbortedError", data: { message: "Cancelled" } } },
    },
  })
  activity.event(local.base, event("idle"))
  expect(activity.get(local.base, "ses_one")?.completed).toBeUndefined()
  activity.event(local.base, event("busy"))
  activity.event(local.base, { directory: local.directory, payload: { type: "global.disposed", properties: {} } })
  activity.snapshot(local, {}, activity.revision())
  expect(activity.get(local.base, "ses_one")?.completed).toBeUndefined()
})

test("unread completions survive reload; viewing or starting again removes the stored dot", () => {
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
  const activity = createSessionActivity(storage)
  activity.event(remote.base, event("busy"))
  activity.event(remote.base, event("idle"))
  const restored = createSessionActivity(storage)
  expect(restored.get(remote.base, "ses_one")?.completed).toBeGreaterThan(0)
  restored.view(remote.base, "ses_one")
  expect(createSessionActivity(storage).get(remote.base, "ses_one")).toBeUndefined()
  activity.event(remote.base, event("busy"))
  expect(createSessionActivity(storage).get(remote.base, "ses_one")).toBeUndefined()
})

test("the mounted indicator updates without replacing the conversation row", () => {
  const activity = createSessionActivity()
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(
    () =>
      web.createComponent(ConversationStatus, {
        get status() {
          return activity.get(local.base, "ses_one")?.status
        },
        get completed() {
          return activity.get(local.base, "ses_one")?.completed
        },
      }),
    host,
  )
  try {
    const slot = host.firstElementChild
    activity.event(local.base, event("busy"))
    expect(host.querySelector('[aria-label="Running"]')).not.toBeNull()
    activity.event(local.base, event("retry"))
    expect(host.querySelector('[aria-label="Retrying"]')).not.toBeNull()
    activity.event(local.base, event("idle"))
    expect(host.querySelector('[aria-label="Completed · Unread"]')).not.toBeNull()
    expect(host.firstElementChild).toBe(slot)
    activity.view(local.base, "ses_one")
    expect(host.querySelector('[aria-label="Completed · Unread"]')).toBeNull()
  } finally {
    dispose()
    host.remove()
  }
})
