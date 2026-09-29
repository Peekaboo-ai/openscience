export const SERVER_FAILURE_THRESHOLD = 3

export function nextServerHealth(healthy: boolean | undefined, failures: number, succeeded: boolean) {
  if (succeeded) return { healthy: true, failures: 0 }
  const count = Math.min(failures + 1, SERVER_FAILURE_THRESHOLD)
  return { healthy: count >= SERVER_FAILURE_THRESHOLD ? false : healthy, failures: count }
}

export function serverHealthTimeout(url: string) {
  const target = new URL(url)
  // SSH 代理也使用回环地址，但探测需要穿过远程链路，不能套用本机的三秒预算。
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  return local && !target.pathname.includes("/remote-workspaces/") ? 3_000 : 30_000
}

export type ServerHealth = { healthy: boolean | undefined; failures: number; checking: boolean }

export function createServerHealth(options: {
  check: (url: string, signal: AbortSignal) => Promise<boolean>
  changed: (state: ServerHealth) => void
  connected?: (url: string) => void
}) {
  let target = ""
  let generation = 0
  let pending: Promise<boolean> | undefined
  let abort: AbortController | undefined
  let state: ServerHealth = { healthy: undefined, failures: 0, checking: false }
  const publish = (next: ServerHealth) => {
    state = next
    options.changed(next)
  }
  const cancel = () => {
    generation++
    abort?.abort()
    abort = undefined
    pending = undefined
  }
  return {
    select(url: string) {
      if (target === url) return
      cancel()
      target = url
      publish({ healthy: undefined, failures: 0, checking: false })
    },
    refresh(): Promise<boolean> {
      if (!target) return Promise.resolve(false)
      // 轮询、切回页面和手动重试共享一次探测，避免一次网络抖动被重复计数。
      if (pending) return pending
      const current = generation
      const url = target
      const controller = new AbortController()
      abort = controller
      publish({ ...state, checking: true })
      pending = Promise.resolve()
        .then(() => options.check(url, controller.signal))
        .catch(() => false)
        .then((succeeded) => {
          // A → B → A 切换后，第一次 A 的迟到结果也不再属于当前连接。
          if (current !== generation) return succeeded
          pending = undefined
          abort = undefined
          publish({ ...nextServerHealth(state.healthy, state.failures, succeeded), checking: false })
          if (succeeded) options.connected?.(url)
          return succeeded
        })
      return pending
    },
    dispose: cancel,
  }
}
