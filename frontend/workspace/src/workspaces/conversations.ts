import { createStore, reconcile } from "solid-js/store"
import type { Session } from "@synsci/sdk/v2/client"

export type ConversationQuery = { base: string; projectID: string; query: string; limit: number }

export function createConversationCache(
  fetch: (query: ConversationQuery, signal: AbortSignal) => Promise<Session[]>,
  capacity = 100,
) {
  function create(query: ConversationQuery) {
    const [state, setState] = createStore({ sessions: [] as Session[], ready: false, error: "", more: false })
    const abort = new AbortController()
    let pending: Promise<void> | undefined
    let fetched = 0
    let revision = 0
    let users = 0
    const load = (fresh = false): Promise<void> => {
      if (abort.signal.aborted) return Promise.resolve()
      // 写操作必须等在途快照结束后再读取；普通展开和轮询共享同一请求。
      if (pending) return fresh ? pending.then(() => load(true)) : pending
      if (!fresh && fetched && Date.now() - fetched < 2000) return Promise.resolve()
      const version = revision
      pending = fetch(query, abort.signal)
        .then((sessions) => {
          if (abort.signal.aborted || version !== revision) return
          setState(
            "sessions",
            reconcile(
              sessions.filter((session) => !session.parentID),
              { key: "id" },
            ),
          )
          setState({ ready: true, error: "", more: sessions.length >= query.limit })
          fetched = Date.now()
        })
        .catch((error) => {
          if (abort.signal.aborted || version !== revision) return
          setState({ ready: true, error: error instanceof Error ? error.message : "Could not load conversations" })
        })
        .finally(() => {
          pending = undefined
        })
      return pending
    }
    return {
      query,
      state,
      load,
      retain() {
        users++
      },
      release() {
        users = Math.max(0, users - 1)
      },
      get active() {
        return users > 0
      },
      invalidate() {
        revision++
        fetched = 0
      },
      dispose() {
        abort.abort()
      },
    }
  }
  const entries = new Map<string, ReturnType<typeof create>>()
  return {
    get(query: ConversationQuery) {
      const key = JSON.stringify([query.base, query.projectID, query.query, query.limit])
      const entry = entries.get(key) ?? create(query)
      entries.delete(key)
      entries.set(key, entry)
      for (const [oldKey, old] of entries) {
        if (entries.size <= capacity) break
        if (old === entry || old.active) continue
        old.dispose()
        entries.delete(oldKey)
      }
      return entry
    },
    invalidate(base: string, projectID: string) {
      for (const entry of entries.values())
        if (entry.query.base === base && entry.query.projectID === projectID) entry.invalidate()
    },
    dispose() {
      for (const entry of entries.values()) entry.dispose()
      entries.clear()
    },
  }
}
