import { describe, expect, test } from "bun:test"
import {
  createServerHealth,
  nextServerHealth,
  serverHealthTimeout,
  SERVER_FAILURE_THRESHOLD,
  type ServerHealth,
} from "./server-health"

describe("server health hysteresis", () => {
  test("keeps a usable server through transient probe failures", () => {
    const first = nextServerHealth(true, 0, false)
    const second = nextServerHealth(first.healthy, first.failures, false)

    expect(first).toEqual({ healthy: true, failures: 1 })
    expect(second).toEqual({ healthy: true, failures: 2 })
  })

  test("disconnects after the bounded threshold and recovers immediately", () => {
    const failed = nextServerHealth(true, SERVER_FAILURE_THRESHOLD - 1, false)
    expect(failed).toEqual({ healthy: false, failures: SERVER_FAILURE_THRESHOLD })
    expect(nextServerHealth(failed.healthy, failed.failures, true)).toEqual({ healthy: true, failures: 0 })
  })
})

describe("server health request ownership", () => {
  const local = "http://127.0.0.1:4106"
  const remote = `${local}/remote-workspaces/bio/api`
  const deferred = () => Promise.withResolvers<boolean>()
  test("gives a remote proxy the remote latency budget", () => {
    expect(serverHealthTimeout(local)).toBe(3_000)
    expect(serverHealthTimeout("http://[::1]:4106")).toBe(3_000)
    expect(serverHealthTimeout(remote)).toBe(30_000)
    expect(serverHealthTimeout("https://research.example.com")).toBe(30_000)
  })
  test("coalesces manual, focus and scheduled checks into one failure", async () => {
    const reply = deferred()
    let requests = 0
    let latest: ServerHealth | undefined
    const health = createServerHealth({
      check: async () => {
        requests++
        return reply.promise
      },
      changed: (value) => {
        latest = value
      },
    })
    health.select(remote)
    const first = health.refresh()
    expect(health.refresh()).toBe(first)
    expect(health.refresh()).toBe(first)
    reply.resolve(false)
    await first
    expect(requests).toBe(1)
    expect(latest).toEqual({ healthy: undefined, failures: 1, checking: false })
    health.dispose()
  })
  test("does not apply late results after switching A to B to A", async () => {
    const replies = [deferred(), deferred(), deferred()]
    const signals: AbortSignal[] = []
    let latest: ServerHealth | undefined
    const health = createServerHealth({
      check: (_, signal) => {
        signals.push(signal)
        return replies[signals.length - 1]!.promise
      },
      changed: (value) => {
        latest = value
      },
    })
    health.select(local)
    const old = health.refresh()
    await Promise.resolve()
    health.select(remote)
    const other = health.refresh()
    await Promise.resolve()
    health.select(local)
    const current = health.refresh()
    await Promise.resolve()
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(true)
    replies[2]!.resolve(true)
    await current
    replies[0]!.resolve(false)
    replies[1]!.resolve(false)
    await Promise.all([old, other])
    expect(latest).toEqual({ healthy: true, failures: 0, checking: false })
    health.dispose()
  })
  test("still reports persistent failures and clears them after recovery", async () => {
    let succeeds = false
    let latest: ServerHealth | undefined
    const health = createServerHealth({
      check: async () => succeeds,
      changed: (value) => {
        latest = value
      },
    })
    health.select(remote)
    for (let i = 0; i < SERVER_FAILURE_THRESHOLD; i++) await health.refresh()
    expect(latest?.healthy).toBe(false)
    succeeds = true
    await health.refresh()
    expect(latest).toEqual({ healthy: true, failures: 0, checking: false })
    health.dispose()
  })
  test("aborts an unmounted monitor without publishing late state", async () => {
    const reply = deferred()
    let signal: AbortSignal | undefined
    const changes: ServerHealth[] = []
    const health = createServerHealth({
      check: (_, value) => {
        signal = value
        return reply.promise
      },
      changed: (value) => {
        changes.push(value)
      },
    })
    health.select(remote)
    const result = health.refresh()
    await Promise.resolve()
    health.dispose()
    const count = changes.length
    expect(signal?.aborted).toBe(true)
    reply.resolve(true)
    await result
    expect(changes).toHaveLength(count)
  })
})
