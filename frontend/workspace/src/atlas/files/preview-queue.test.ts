import { expect, test } from "bun:test"
import { createPreviewQueue } from "./preview-queue"

test("thumbnail work is bounded and a closed queued card never downloads", async () => {
  const queue = createPreviewQueue(2)
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const cancelled = new AbortController()
  const started: string[] = []
  const run = (name: string, pending: Promise<void>, signal = new AbortController().signal) =>
    queue(async () => {
      started.push(name)
      await pending
      return name
    }, signal)
  const a = run("a", first.promise)
  const b = run("b", second.promise)
  const c = run("closed", Promise.resolve(), cancelled.signal).catch((error) => error.name)
  const d = run("d", Promise.resolve())
  await Promise.resolve()
  expect(started).toEqual(["a", "b"])
  cancelled.abort()
  expect(await c).toBe("AbortError")
  first.resolve()
  expect(await a).toBe("a")
  expect(await d).toBe("d")
  second.resolve()
  await b
  expect(started).toEqual(["a", "b", "d"])
})

test("a failed thumbnail releases capacity for the next result", async () => {
  const queue = createPreviewQueue(1)
  const first = queue(async () => {
    throw new Error("unreadable")
  }, new AbortController().signal)
  const next = queue(async () => "next result", new AbortController().signal)
  await expect(first).rejects.toThrow("unreadable")
  expect(await next).toBe("next result")
})
