export function createPreviewQueue(limit = 4) {
  let active = 0
  const waiting: Array<() => void> = []
  const drain = () => {
    while (active < limit && waiting.length) waiting.shift()!()
  }
  return <T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> =>
    new Promise((resolve, reject) => {
      const cancel = () => {
        const index = waiting.indexOf(start)
        if (index !== -1) waiting.splice(index, 1)
        reject(signal.reason ?? new DOMException("Preview closed", "AbortError"))
      }
      const start = () => {
        signal.removeEventListener("abort", cancel)
        if (signal.aborted) return cancel()
        active++
        void Promise.resolve()
          .then(run)
          .then(resolve, reject)
          .finally(() => {
            active--
            drain()
          })
      }
      if (signal.aborted) return cancel()
      signal.addEventListener("abort", cancel, { once: true })
      waiting.push(start)
      drain()
    })
}

// 多张卡片共享并发预算，避免打开 Results 就占满远端请求和 PDF worker。
export const previewQueue = createPreviewQueue()
