// 同时限制响应头和响应体；部分桌面传输不会响应 abort，因此也需让调用方及时退出等待。
export async function requestDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  parent?: AbortSignal | null,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => undefined
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => {
      const reason = parent?.reason ?? new DOMException("Request cancelled", "AbortError")
      controller.abort(reason)
      reject(reason)
    }
    if (parent?.aborted) return abort()
    parent?.addEventListener("abort", abort, { once: true })
    timer = setTimeout(() => {
      const error = new DOMException("The server took too long to respond. Please retry.", "TimeoutError")
      controller.abort(error)
      reject(error)
    }, milliseconds)
  })
  try {
    return await Promise.race([
      interrupted,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return run(controller.signal)
      }),
    ])
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener("abort", abort)
  }
}
