import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { SessionController } from "../../src/session/controller"
import { tmpdir } from "../fixture/fixture"

test("an old cancellation and completion cannot take ownership from a replacement", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    async fn() {
      const first = SessionController.start("session")!
      expect(SessionController.cancel("session", first)).toBe(true)
      const second = SessionController.start("session")!
      expect(SessionController.cancel("session", first, SessionController.completed)).toBe(false)
      expect(second.aborted).toBe(false)
      expect(SessionController.signal("session")).toBe(second)
      SessionController.cancel("session", second)
    },
  })
})

test("cancelling independent guidance releases a stalled preparation without taking the running controller", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    async fn() {
      const active = SessionController.start("session")!
      const controller = new AbortController()
      const delayed = Promise.withResolvers<void>()
      const reached = Promise.withResolvers<void>()
      const late = Promise.withResolvers<void>()
      const failure = new Error("Preparation cancelled")
      const preparing = SessionController.prepare("session", controller, async () => {
        reached.resolve()
        await delayed.promise
        try {
          SessionController.assertPreparing("session")
        } finally {
          late.resolve()
        }
      })
      await reached.promise
      controller.abort(failure)
      await expect(preparing).rejects.toBe(failure)
      expect(active.aborted).toBe(false)
      expect(SessionController.signal("session")).toBe(active)
      delayed.resolve()
      await late.promise
      SessionController.cancel("session", active)
    },
  })
})

test("preparation transfers its exact controller to the loop and detached work cannot inherit it", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    async fn() {
      const before = SessionController.activeCount()
      await SessionController.reserve("session", async () => {
        const preparing = SessionController.signal("session")!
        await SessionController.detached(async () => {
          expect(() => SessionController.start("session")).toThrow()
        })
        expect(SessionController.start("session")).toBe(preparing)
        expect(SessionController.start("session")).toBeUndefined()
        expect(SessionController.activeCount()).toBe(before + 1)
      })
      expect(SessionController.has("session")).toBe(false)
      expect(SessionController.activeCount()).toBe(before)
    },
  })
})

test("aborting preparation rejects immediately even while its work is waiting", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    async fn() {
      const release = Promise.withResolvers<void>()
      const abort = new AbortController()
      const work = SessionController.reserve("session", () => release.promise, abort.signal)
      void work.catch(() => undefined)
      abort.abort(new Error("cancel preparation"))
      await expect(work).rejects.toThrow("cancel preparation")
      expect(SessionController.has("session")).toBe(false)
      release.resolve()
    },
  })
})

test("instance disposal rejects waiters once even when an abort listener reenters cancellation", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    async fn() {
      const before = SessionController.activeCount()
      const signal = SessionController.start("session")!
      const waiter = SessionController.join("session").catch((error: unknown) => error)
      signal.addEventListener(
        "abort",
        () => {
          expect(SessionController.cancel("session", signal)).toBe(false)
        },
        { once: true },
      )
      await Instance.dispose({ strict: true })
      expect(signal.aborted).toBe(true)
      expect(await waiter).toBeDefined()
      expect(SessionController.activeCount()).toBe(before)
    },
  })
})
