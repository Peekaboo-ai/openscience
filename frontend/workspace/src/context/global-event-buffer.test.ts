import { describe, expect, test } from "bun:test"
import type { Event } from "@synsci/sdk/v2/client"
import { createGlobalEventBuffer } from "./global-event-buffer"
import { createNotificationLifecycle } from "./notification-lifecycle"

const busy: Event = { type: "session.status", properties: { sessionID: "ses_one", status: { type: "busy" } } }
const stopped: Event = { type: "session.status", properties: { sessionID: "ses_one", status: { type: "idle" } } }
const idle: Event = { type: "session.idle", properties: { sessionID: "ses_one" } }
const error: Event = {
  type: "session.error",
  properties: { sessionID: "ses_one", error: { name: "UnknownError", data: { message: "Failed" } } },
}

describe("buffered notification lifecycle", () => {
  test("two runs completing in one paint batch each notify once", () => {
    const queue = createGlobalEventBuffer()
    const lifecycle = createNotificationLifecycle()
    const notifications: string[] = []
    for (const event of [busy, stopped, idle, idle, busy, stopped, idle]) queue.push("/project", event)
    queue.flush(({ directory, payload }) => {
      if (lifecycle.accept(directory, payload)) notifications.push(payload.type)
    })
    expect(notifications).toEqual(["session.idle", "session.idle"])
    expect(queue.length).toBe(0)
  })

  test("failure followed by a successful run in the same batch keeps both outcomes", () => {
    const queue = createGlobalEventBuffer()
    const lifecycle = createNotificationLifecycle()
    const notifications: string[] = []
    for (const event of [busy, error, stopped, idle, busy, stopped, idle]) queue.push("/project", event)
    queue.flush(({ directory, payload }) => {
      if (lifecycle.accept(directory, payload)) notifications.push(payload.type)
    })
    expect(notifications).toEqual(["session.error", "session.idle"])
  })

  test("still coalesces replaceable message snapshots without crossing directories", () => {
    const queue = createGlobalEventBuffer()
    const part = (text: string): Event => ({
      type: "message.part.updated",
      properties: { part: { id: "part_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text } },
    })
    queue.push("/one", part("initial"))
    queue.push("/two", part("other project"))
    queue.push("/one", busy)
    queue.push("/one", part("complete"))
    const events: Array<{ directory: string; payload: Event }> = []
    queue.flush((event) => events.push(event))
    expect(events).toEqual([
      { directory: "/two", payload: part("other project") },
      { directory: "/one", payload: busy },
      { directory: "/one", payload: part("complete") },
    ])
    queue.push("/one", idle)
    queue.flush((event) => events.push(event))
    expect(events.at(-1)?.payload).toEqual(idle)
    expect(events).toHaveLength(4)
  })
})
