import { expect, test } from "bun:test"
import { remoteWorkspaceBlocked } from "./availability"
import type { RemoteWorkspace } from "./context"

const remote = { id: "bio", state: "connected" } as RemoteWorkspace
test("an established remote remains available while its catalog reloads", () => {
  expect(remoteWorkspaceBlocked({ selected: "bio", remote })).toBe(false)
})
test("only an unknown or disconnected remote gates the conversation", () => {
  for (const state of ["disconnected", "connecting", "error"] as const) {
    expect(remoteWorkspaceBlocked({ selected: "bio", remote: { ...remote, state } })).toBe(true)
  }
  expect(remoteWorkspaceBlocked({ selected: "bio" })).toBe(true)
  expect(remoteWorkspaceBlocked({ selected: "" })).toBe(false)
})
