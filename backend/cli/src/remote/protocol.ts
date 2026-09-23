import z from "zod"
import type { Readable, Writable } from "node:stream"

export const PREFIX = "OPENSCIENCE_REMOTE_V1 "
export const LIMIT = 32 * 1024 * 1024
export const Frame = z.object({
  id: z.string().max(100),
  type: z.enum(["hello", "request", "headers", "data", "end", "error", "cancel", "ws", "open", "message", "close"]),
  path: z.string().max(16_384).optional(),
  method: z.string().max(20).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  status: z.number().int().min(100).max(599).optional(),
  data: z.string().max(LIMIT).optional(),
  binary: z.boolean().optional(),
  version: z.number().optional(),
  home: z.string().optional(),
})
export type Frame = z.infer<typeof Frame>

export function channel(
  input: Readable,
  output: Writable,
  receive: (frame: Frame) => void,
  closed: (error: Error) => void,
) {
  let pending = ""
  let ended = false
  let queue = Promise.resolve()
  let queuedBytes = 0
  const fail = (error: Error) => {
    if (ended) return
    ended = true
    closed(error)
  }
  input.setEncoding("utf8")
  input.on("data", (chunk: string) => {
    if (ended) return
    pending += chunk
    while (!ended) {
      const end = pending.indexOf("\n")
      if (end < 0) break
      if (end > LIMIT) {
        fail(new Error("Remote protocol frame exceeded its limit"))
        return
      }
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (!line.startsWith(PREFIX)) continue
      try {
        receive(Frame.parse(JSON.parse(line.slice(PREFIX.length))))
      } catch {
        fail(new Error("Invalid remote protocol frame"))
        return
      }
    }
    if (pending.length > LIMIT) fail(new Error("Remote protocol frame exceeded its limit"))
  })
  input.on("end", () => fail(new Error("Remote connection closed")))
  input.on("error", fail)
  output.on("error", fail)
  return {
    send(frame: Frame) {
      if (ended) return Promise.reject(new Error("Remote connection is closed"))
      const line = PREFIX + JSON.stringify(frame) + "\n"
      queuedBytes += line.length
      if (queuedBytes > LIMIT * 2) {
        fail(new Error("Remote connection is not consuming data"))
        return Promise.reject(new Error("Remote connection backpressure limit reached"))
      }
      const write = queue.then(
        () =>
          new Promise<void>((resolve, reject) => {
            output.write(line, (error) => (error ? reject(error) : resolve()))
          }),
      )
      queue = write.catch(fail).finally(() => {
        queuedBytes -= line.length
      })
      return write
    },
  }
}

// 仅转发当前远端进程的 API；绝对 URL、协议相对路径和本地凭据都不能穿过连接。
export function remoteURL(origin: string, value: string) {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    throw new Error("Invalid remote API path")
  const url = new URL(value, origin)
  if (url.origin !== new URL(origin).origin) throw new Error("Remote API origin mismatch")
  return url
}

export function forwardedHeaders(input: Headers) {
  const result: Record<string, string> = {}
  for (const name of [
    "content-type",
    "accept",
    "range",
    "if-none-match",
    "x-openscience-directory",
    "x-openscience-project",
    "x-openscience-session",
    "last-event-id",
  ]) {
    const value = input.get(name)
    if (value) result[name] = value
  }
  return result
}
