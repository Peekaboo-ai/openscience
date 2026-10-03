// 后台会话只占一个请求槽；切换路由时丢弃尚未开始的旧任务，已开始的请求仍可填充缓存。
export function createSessionPrefetch(input: {
  load: (id: string) => Promise<void>
  failed: (id: string, error: unknown) => void
}) {
  const attempted = new Set<string>()
  let queued: string[] = []
  let running = false
  let disposed = false
  const drain = async () => {
    if (running || disposed) return
    running = true
    try {
      while (queued.length && !disposed) {
        const id = queued.shift()!
        if (attempted.has(id)) continue
        attempted.add(id)
        await input.load(id).catch((error) => input.failed(id, error))
      }
    } finally {
      running = false
    }
  }
  return {
    schedule(ids: string[]) {
      queued = ids.filter((id) => !attempted.has(id))
      void drain()
    },
    dispose() {
      disposed = true
      queued = []
    },
  }
}
