import { expect, test } from "bun:test"
import { createSessionPrefetch } from "./session-prefetch"

test("prefetch serializes requests and replaces stale queued sessions after navigation", async () => {
  const calls: string[] = []
  let finish!: () => void
  const queue = createSessionPrefetch({
    load: async (id) => {
      calls.push(id)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    },
    failed: () => {
      throw new Error("Unexpected failure")
    },
  })
  queue.schedule(["a", "b", "c"])
  expect(calls).toEqual(["a"])
  queue.schedule(["d", "e"])
  finish()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toEqual(["a", "d"])
  queue.dispose()
  finish()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toEqual(["a", "d"])
})

test("failed prefetch is reported and does not block the next child", async () => {
  const calls: string[] = []
  const failures: string[] = []
  const queue = createSessionPrefetch({
    load: async (id) => {
      calls.push(id)
      if (id === "a") throw new Error("offline")
    },
    failed: (id) => failures.push(id),
  })
  queue.schedule(["a", "b", "b"])
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toEqual(["a", "b"])
  expect(failures).toEqual(["a"])
  queue.dispose()
})
