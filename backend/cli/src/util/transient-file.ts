import { setTimeout as sleep } from "node:timers/promises"

const delays = [50, 100, 200, 400, 800] as const

/** 改编 ZCode 328c1a0 workspace-hook-trust-store.ts 的 renameWithRetry。
 * Windows 索引器/杀软和延迟关闭的句柄可暂时阻止原子操作；不删除目标，不重试其他错误。
 * 文件租约额外传入取消信号和等待预算，不能因为重试延长授权或取消的生命周期。 */
export async function transientFile<T>(
  action: () => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number; delays?: readonly number[] } = {},
): Promise<T> {
  const started = Date.now()
  const retry = options.delays ?? (process.platform === "win32" ? delays : [])
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted()
    try {
      return await action()
    } catch (error) {
      const delay = retry[attempt]
      if (
        delay === undefined ||
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EPERM", "EBUSY", "EACCES"].includes(String(error.code)) ||
        (options.timeoutMs !== undefined && Date.now() - started + delay >= options.timeoutMs)
      )
        throw error
      await sleep(delay, undefined, { signal: options.signal })
    }
  }
}
