import { expect, test } from "bun:test"
import { createTerminalGeometry, type TerminalSize } from "./terminal-geometry"

test("serializes remote resize acknowledgements and coalesces intermediate layouts", async () => {
  const writes: TerminalSize[] = []
  const gates: ReturnType<typeof Promise.withResolvers<void>>[] = []
  const geometry = createTerminalGeometry((size) => {
    writes.push(size)
    const gate = Promise.withResolvers<void>()
    gates.push(gate)
    return gate.promise
  })
  geometry.set({ cols: 80, rows: 24 })
  const first = geometry.flush()
  geometry.set({ cols: 50, rows: 30 })
  geometry.set({ cols: 100, rows: 36 })
  const latest = geometry.flush()
  expect(writes).toEqual([{ cols: 80, rows: 24 }])
  gates[0].resolve()
  await Promise.resolve()
  expect(writes).toEqual([
    { cols: 80, rows: 24 },
    { cols: 100, rows: 36 },
  ])
  gates[1].resolve()
  await Promise.all([first, latest])
  await geometry.flush()
  expect(writes).toHaveLength(2)
})

test("retries a failed size, invalidates on reconnect, and never resizes after disposal", async () => {
  let attempts = 0
  const geometry = createTerminalGeometry(async () => {
    if (++attempts === 1) throw new Error("offline")
  })
  geometry.set({ cols: 60, rows: 24 })
  await expect(geometry.flush()).rejects.toThrow("offline")
  await geometry.flush()
  geometry.invalidate()
  await geometry.flush()
  expect(attempts).toBe(3)
  geometry.set({ cols: 0, rows: NaN })
  await geometry.flush()
  expect(attempts).toBe(3)
  geometry.dispose()
  geometry.set({ cols: 120, rows: 24 })
  await geometry.flush()
  expect(attempts).toBe(3)
})
