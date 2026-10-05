import { expect, test } from "bun:test"
import { createContextActions } from "./context-actions"

test("replays the latest inspector click when a cold project route mounts", () => {
  const actions = createContextActions(() => "local:project")
  const received: string[] = []
  actions.open("files")
  actions.open("kernels")
  actions.register((context) => received.push(context))
  actions.open("terminal")
  expect(received).toEqual(["kernels", "terminal"])
})

test("never replays an inspector click onto a different project or backend", () => {
  let scope = "local:project"
  const actions = createContextActions(() => scope)
  const received: string[] = []
  actions.open("kernels")
  scope = "remote:project"
  actions.register((context) => received.push(context))
  expect(received).toEqual([])
})

test("navigation does not dispatch to an old project or let its cleanup remove the new handler", () => {
  let scope = "project-a"
  const actions = createContextActions(() => scope)
  const received: string[] = []
  const cleanup = actions.register(() => received.push("old"))
  scope = "project-b"
  actions.open("kernels")
  actions.register((context) => received.push(context))
  cleanup()
  actions.open("files")
  expect(received).toEqual(["kernels", "files"])
})
