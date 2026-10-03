import { expect, test } from "bun:test"
import { createPendingPrompts, pendingPromptKey } from "./prompt-pending"

test("stop cancels every pending submission for its server and conversation", () => {
  const pending = createPendingPrompts()
  const key = pendingPromptKey("local", "/lab", "same-session")
  const restored: string[] = []
  const first = new AbortController()
  const guide = new AbortController()
  const remote = new AbortController()
  pending.add(key, { abort: first, cleanup: () => restored.push("first") })
  pending.add(key, { abort: guide, cleanup: () => restored.push("guide") })
  pending.add(pendingPromptKey("remote", "/lab", "same-session"), {
    abort: remote,
    cleanup: () => restored.push("remote"),
  })
  pending.abort(key)
  pending.abort(key)
  expect(first.signal.aborted).toBe(true)
  expect(guide.signal.aborted).toBe(true)
  expect(remote.signal.aborted).toBe(false)
  expect(restored).toEqual(["guide", "first"])
})

test("late completion cannot remove cancellation ownership of a later submission", () => {
  const pending = createPendingPrompts()
  const old = pending.add("session", { abort: new AbortController(), cleanup() {} })
  pending.abort("session")
  const current = new AbortController()
  pending.add("session", { abort: current, cleanup() {} })
  old()
  pending.abort("session")
  expect(current.signal.aborted).toBe(true)
})

test("accepted submissions relinquish local cancellation to the server", () => {
  const pending = createPendingPrompts()
  const controller = new AbortController()
  const release = pending.add("session", {
    abort: controller,
    cleanup() {
      throw new Error("Already submitted")
    },
  })
  release()
  pending.abort("session")
  expect(controller.signal.aborted).toBe(false)
})
