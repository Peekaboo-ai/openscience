import { expect, test } from "bun:test"
import type { Event } from "@synsci/sdk/v2/client"
import { createNotificationLifecycle } from "./notification-lifecycle"

const idle: Event = { type: "session.idle", properties: { sessionID: "ses_one" } }
const busy: Event = { type: "session.status", properties: { sessionID: "ses_one", status: { type: "busy" } } }
const failed: Event = {
  type: "session.error",
  properties: { sessionID: "ses_one", error: { name: "UnknownError", data: { message: "Provider unavailable" } } },
}

test("a failed run never creates a second successful-completion notification", () => {
  const lifecycle = createNotificationLifecycle()
  expect(lifecycle.accept("/project", busy)).toBe(false)
  expect(lifecycle.accept("/project", failed)).toBe(true)
  expect(lifecycle.accept("/project", idle)).toBe(false)
  expect(lifecycle.accept("/project", idle)).toBe(false)
})

test("cancelling a run suppresses its final idle event even though cancellation has no error notification", () => {
  const lifecycle = createNotificationLifecycle()
  lifecycle.accept("/project", {
    type: "session.error",
    properties: { sessionID: "ses_one", error: { name: "MessageAbortedError", data: { message: "Cancelled" } } },
  })
  expect(lifecycle.accept("/project", idle)).toBe(false)
})

test("repeated completion events notify once, and a later run can notify again", () => {
  const lifecycle = createNotificationLifecycle()
  expect(lifecycle.accept("/project", idle)).toBe(true)
  expect(lifecycle.accept("/project", idle)).toBe(false)
  lifecycle.accept("/project", busy)
  expect(lifecycle.accept("/project", idle)).toBe(true)
})

test("the next run clears failure state and different projects remain independent", () => {
  const lifecycle = createNotificationLifecycle()
  lifecycle.accept("/project", failed)
  expect(lifecycle.accept("/other", idle)).toBe(true)
  lifecycle.accept("/project", busy)
  expect(lifecycle.accept("/project", idle)).toBe(true)
})
