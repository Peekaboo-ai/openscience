export const SESSION_MESSAGE_CHUNK = 400
// 首屏优先展示最近对话；断线补齐继续使用较大的窗口，避免丢失离线期间的消息。
export const SESSION_INITIAL_MESSAGES = 80

export type SessionHydrationInput = {
  hasSession: boolean
  hasMessages: boolean
  hydratedLimit?: number
  messageCount: number
  refresh?: boolean
}

export type SessionHydrationPlan = {
  skip: boolean
  loadMessages: boolean
  limit: number
}

export type HydrationMergeOptions = {
  /** Keep cached entities that are outside a partial server window. */
  preserveCached?: boolean
  /** Cached entities changed after the server snapshot request began. */
  preferCached?: ReadonlySet<string>
  /** Entities removed after the server snapshot request began. */
  removed?: ReadonlySet<string>
}

export function mergeHydratedMessages<T extends { id: string }>(
  cached: readonly T[],
  incoming: readonly T[],
  options: HydrationMergeOptions = {},
) {
  const merged = new Map((options.preserveCached ?? true) ? cached.map((message) => [message.id, message]) : [])
  for (const message of incoming) merged.set(message.id, message)
  if (options.preferCached?.size) {
    const live = new Map(cached.map((message) => [message.id, message]))
    for (const id of options.preferCached) {
      const message = live.get(id)
      if (message) merged.set(id, message)
    }
  }
  for (const id of options.removed ?? []) merged.delete(id)
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** Leave enough room for a full missed-event chunk, not just a handful of turns. */
export function reconnectHydrationLimit(messageCount: number) {
  return Math.max(SESSION_MESSAGE_CHUNK, messageCount + SESSION_MESSAGE_CHUNK)
}

/**
 * The messages endpoint returns the newest N entries. If that window is full
 * and has not reached any previously hydrated message, expand until it does so
 * there can be no unobserved gap between cached and fetched history.
 */
export function nextReconnectHydrationLimit(input: { limit: number; snapshotCount: number; overlapsCached: boolean }) {
  if (input.snapshotCount < input.limit || input.overlapsCached) return undefined
  return input.limit + Math.max(input.limit, SESSION_MESSAGE_CHUNK)
}

// 缓存与最新窗口之间必须有交集，否则扩大窗口直到连续，不能把丢失的历史误判为已加载。
export async function fetchMessageWindow<T extends { info: { id: string; role?: string } }>(input: {
  limit: number
  cached: readonly { id: string }[]
  fetch: (limit: number) => Promise<T[]>
}) {
  const cached = new Set(input.cached.map((message) => message.id))
  let limit = input.limit
  for (;;) {
    const items = await input.fetch(limit)
    // 长工具调用链可能占满窗口；至少包含一个用户提问，时间线才有完整的回合入口。
    if (
      items.length === limit &&
      items.some((item) => item.info.role) &&
      !items.some((item) => item.info.role === "user")
    ) {
      limit *= 2
      continue
    }
    const next = cached.size
      ? nextReconnectHydrationLimit({
          limit,
          snapshotCount: items.length,
          overlapsCached: items.some((message) => cached.has(message.info.id)),
        })
      : undefined
    if (next === undefined) return { items, limit }
    limit = next
  }
}

/** Only the newest reconnect request for one session may update its transcript. */
export function createReconnectGenerationGuard() {
  const active = new Map<string, number>()
  let sequence = 0
  return {
    begin(key: string) {
      const generation = ++sequence
      active.set(key, generation)
      return generation
    },
    isCurrent(key: string, generation: number) {
      return active.get(key) === generation
    },
    invalidate(key: string) {
      active.delete(key)
    },
  }
}

function initialLimit(count: number) {
  if (count <= SESSION_INITIAL_MESSAGES) return SESSION_INITIAL_MESSAGES
  return Math.ceil(count / SESSION_MESSAGE_CHUNK) * SESSION_MESSAGE_CHUNK
}

/**
 * Plan a session transcript load without coupling route lifecycle to the SDK.
 *
 * Normal callers keep the existing cache fast path. An active route revisit
 * opts into refresh, which requests the cached history plus one chunk of
 * headroom. The caller merges that snapshot with the hydrated transcript so
 * even an unusually long inactive turn cannot truncate older history.
 */
export function sessionHydrationPlan(input: SessionHydrationInput): SessionHydrationPlan {
  const hydrated = input.hydratedLimit !== undefined
  const refresh = input.refresh === true
  const limit = refresh
    ? input.messageCount === 0 && !hydrated
      ? SESSION_INITIAL_MESSAGES
      : Math.max(input.hydratedLimit ?? 0, input.messageCount + SESSION_INITIAL_MESSAGES)
    : hydrated
      ? (input.hydratedLimit ?? SESSION_MESSAGE_CHUNK)
      : initialLimit(input.messageCount)

  return {
    skip: input.hasSession && input.hasMessages && hydrated && !refresh,
    loadMessages: !input.hasMessages || !hydrated || refresh,
    limit,
  }
}
