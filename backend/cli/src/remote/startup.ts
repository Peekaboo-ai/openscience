import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

export const PLATFORM_COMMAND = 'printf \'\\nOPENSCIENCE_PLATFORM %s %s\\n\' "$(uname -s)" "$(uname -m)"; exec sh -s'

export async function openRemoteShell(
  start: () => ChildProcessWithoutNullStreams,
  signal: AbortSignal,
  retry?: (attempt: number) => void,
) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    const proc = start()
    try {
      return { proc, platform: await startupReply(proc, "OPENSCIENCE_PLATFORM ", signal) }
    } catch (error) {
      proc.stdin.destroy()
      proc.kill()
      // 仅重试尚未启动后端的只读平台探测；认证、主机密钥错误和科研命令均不可自动重放。
      const rejected =
        error instanceof Error &&
        /permission denied|authentication failed|host key verification failed|remote host identification has changed|invalid format|incorrect passphrase/i.test(
          error.message,
        )
      const transient =
        error instanceof Error &&
        /connection.*(?:closed|reset|timed out|refused)|banner exchange|remote startup timed out/i.test(error.message)
      if (!retry || signal.aborted || attempt >= 2 || rejected || !transient) throw error
      retry(attempt + 2)
      await delay(1500 * (attempt + 1), undefined, { signal })
    }
  }
}

export function startupReply(
  proc: ChildProcessWithoutNullStreams,
  prefix: string,
  signal: AbortSignal,
  command?: string,
  timeout = 90_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0)
    let diagnostic = ""
    let settled = false
    let received = 0
    const cleanup = () => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      proc.stdout.pause()
      proc.stdout.off("data", data)
      proc.stdout.off("error", failed)
      proc.stderr.off("data", stderr)
      proc.off("error", failed)
      proc.off("close", closed)
      proc.stdin.off("error", failed)
      signal.removeEventListener("abort", cancelled)
      return true
    }
    const failed = (error: Error) => {
      if (!cleanup()) return
      reject(error)
    }
    const closed = () => failed(new Error(diagnostic.trim() || "Remote connection closed during startup"))
    const cancelled = () => failed(new Error("Connection cancelled"))
    const stderr = (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8000)
    }
    const data = (chunk: Buffer) => {
      received += chunk.length
      pending = Buffer.concat([pending, chunk])
      if (received > 64 * 1024) return failed(new Error("Remote startup output exceeded its limit"))
      for (;;) {
        const end = pending.indexOf(10)
        if (end < 0) return
        const line = pending.subarray(0, end).toString().replace(/\r$/, "")
        pending = pending.subarray(end + 1)
        if (!line.startsWith(prefix)) continue
        cleanup()
        // 交接给下一阶段前保留同一块中的剩余字节，不能丢失紧随标记的协议帧。
        if (pending.length) proc.stdout.unshift(pending)
        resolve(line.slice(prefix.length))
        return
      }
    }
    const timer = setTimeout(
      () =>
        failed(
          new Error(
            `Remote startup timed out waiting for the remote response${diagnostic ? `: ${diagnostic.trim()}` : ""}`,
          ),
        ),
      timeout,
    )
    proc.stdout.on("data", data)
    proc.stdout.on("error", failed)
    proc.stderr.on("data", stderr)
    proc.on("error", failed)
    proc.on("close", closed)
    proc.stdin.on("error", failed)
    signal.addEventListener("abort", cancelled, { once: true })
    if (signal.aborted) return cancelled()
    if (proc.exitCode !== null || proc.signalCode !== null) return closed()
    proc.stdout.resume()
    if (command) proc.stdin.write(`${command}\n`, (error) => error && failed(error))
  })
}
