import { afterAll, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createTestServer } from "../../test/vite"
import type { Session } from "@synsci/sdk/v2/client"

const server = await createTestServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  logLevel: "silent",
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser"], dedupe: ["solid-js"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser"] } },
})
const { createConversationCache } = (await server.ssrLoadModule(
  "/src/workspaces/conversations.ts",
)) as typeof import("./conversations")
afterAll(() => server.close())
const query = { base: "http://local", projectID: "project", query: "", limit: 50 }
const session = (id: string, title = id) => ({ id, title, time: { created: 1, updated: 1 } }) as Session

test("reopening a project keeps its conversations and shares an in-flight request", async () => {
  let calls = 0
  const result = Promise.withResolvers<Session[]>()
  const cache = createConversationCache(async () => {
    calls++
    return result.promise
  })
  try {
    const first = cache.get(query)
    first.retain()
    const load = first.load()
    first.release()
    const reopened = cache.get(query)
    expect(reopened).toBe(first)
    expect(reopened.load()).toBe(load)
    result.resolve([session("one")])
    await load
    expect(reopened.state.ready).toBe(true)
    const row = reopened.state.sessions[0]
    await reopened.load(true)
    expect(reopened.state.sessions[0]).toBe(row)
    await reopened.load()
    expect(calls).toBe(2)
  } finally {
    cache.dispose()
  }
})

test("isolates local, remote, search, and pagination snapshots", async () => {
  const cache = createConversationCache(async (q) => [session(q.base + q.query + q.limit)])
  try {
    const entries = [
      query,
      { ...query, base: "http://remote" },
      { ...query, query: "science" },
      { ...query, limit: 100 },
    ].map(cache.get)
    await Promise.all(entries.map((entry) => entry.load()))
    expect(new Set(entries.map((entry) => entry.state.sessions[0].id)).size).toBe(4)
  } finally {
    cache.dispose()
  }
})

test("mutation refresh discards stale responses and failed refresh retains readable rows", async () => {
  const results: ReturnType<typeof Promise.withResolvers<Session[]>>[] = []
  const cache = createConversationCache(() => {
    const result = Promise.withResolvers<Session[]>()
    results.push(result)
    return result.promise
  })
  try {
    const entry = cache.get(query)
    const before = entry.load()
    cache.invalidate(query.base, query.projectID)
    const after = entry.load(true)
    results[0].resolve([session("deleted")])
    await before
    expect(entry.state.sessions).toEqual([])
    results[1].resolve([session("kept")])
    await after
    const refresh = entry.load(true)
    results[2].reject(new Error("offline"))
    await refresh
    expect(entry.state.ready).toBe(true)
    expect(entry.state.sessions[0].id).toBe("kept")
    expect(entry.state.error).toBe("offline")
  } finally {
    cache.dispose()
  }
})

test("bounds inactive caches and aborts their requests without evicting visible projects", async () => {
  const signals: AbortSignal[] = []
  const cache = createConversationCache(async (_q, signal) => {
    signals.push(signal)
    return []
  }, 2)
  const active = cache.get(query)
  active.retain()
  await active.load()
  const inactive = cache.get({ ...query, projectID: "old" })
  await inactive.load()
  cache.get({ ...query, projectID: "new" })
  expect(signals.map((signal) => signal.aborted)).toEqual([false, true])
  expect(cache.get(query)).toBe(active)
  cache.dispose()
  expect(signals.every((signal) => signal.aborted)).toBe(true)
})
