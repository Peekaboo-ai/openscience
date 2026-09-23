import { expect, test } from "bun:test"
import { BashLifecycle } from "../../src/tool/bash-lifecycle"

test("preparation shares the deadline and no continuation runs after timeout", async () => {
  const phases: string[] = []
  using lifecycle = new BashLifecycle(AbortSignal.any([]), 25, (value) => phases.push(value.phase))
  lifecycle.stage("environment")
  await expect(lifecycle.read(Bun.sleep(100))).rejects.toThrow("timed out during environment")
  expect(lifecycle.timedOut).toBe(true)
  expect(() => lifecycle.stage("launching")).toThrow()
  expect(phases).toContain("environment")
})

test("cancel stops preparation without waiting for the read to finish", async () => {
  const controller = new AbortController()
  using lifecycle = new BashLifecycle(controller.signal, 0, () => {})
  const pending = lifecycle.read(new Promise<void>(() => {}))
  controller.abort(new Error("cancelled by user"))
  await expect(pending).rejects.toThrow("cancelled by user")
  expect(lifecycle.timedOut).toBe(false)
})

test("completion disposes its timer and emits no later heartbeat", async () => {
  let updates = 0
  const lifecycle = new BashLifecycle(AbortSignal.any([]), 10, () => updates++)
  lifecycle[Symbol.dispose]()
  await Bun.sleep(30)
  expect(lifecycle.signal.aborted).toBe(false)
  expect(updates).toBe(1)
})
