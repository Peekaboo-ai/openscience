import { channel, forwardedHeaders, remoteURL, type Frame } from "./protocol"
import os from "node:os"

export async function runRemoteWorker() {
  process.env.OPENSCIENCE_AUTH_TOKEN = crypto.randomUUID()
  process.env.OPENSCIENCE_REMOTE_WORKER = "1"
  const { Log } = await import("../util/log")
  await Log.init({ print: false })
  // 远端入口同样需要服务端的后台错误边界与持久日志，不能让一次异步拒绝退出整个工作区。
  process.on("unhandledRejection", (error) => {
    Log.Default.error("remote background rejection", { error: error instanceof Error ? error.stack : String(error) })
  })
  const { Server } = await import("../server/server")
  const { Instance } = await import("../project/instance")
  const server = Server.listen({ port: 0 })
  // HTTP dispatch stays in-process so an inherited proxy cannot intercept
  // authenticated requests between the bridge and its own backend.
  const internal = Server.internalFetch()
  const requests = new Map<string, AbortController>()
  const sockets = new Map<string, WebSocket>()
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    for (const request of requests.values()) request.abort()
    for (const socket of sockets.values()) socket.close()
    server.stop(true)
    // 连接结束先撤销终端/内核进程的所有权，避免遗留无人管理的远端进程。
    setTimeout(() => process.exit(1), 8000).unref()
    void Instance.disposeAll()
      .catch((error) => Log.Default.error("remote shutdown failed", { error }))
      .finally(async () => {
        await Log.flush()
        process.exit(0)
      })
  }
  const wire = channel(
    process.stdin,
    process.stdout,
    (frame) => {
      void handle(frame)
    },
    stop,
  )
  async function handle(frame: Frame) {
    try {
      if (frame.type === "cancel" || frame.type === "close") {
        requests.get(frame.id)?.abort()
        sockets.get(frame.id)?.close()
        return
      }
      if (frame.type === "message") {
        const socket = sockets.get(frame.id)
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(frame.binary ? Buffer.from(frame.data ?? "", "base64") : (frame.data ?? ""))
        return
      }
      if (frame.type !== "request" && frame.type !== "ws") return
      if (requests.has(frame.id) || sockets.has(frame.id) || requests.size + sockets.size > 512)
        throw new Error("Remote request limit reached")
      const url = remoteURL(server.url.origin, frame.path ?? "/")
      const headers = {
        ...forwardedHeaders(new Headers(frame.headers)),
        authorization: `Bearer ${process.env.OPENSCIENCE_AUTH_TOKEN}`,
      }
      if (frame.type === "ws") {
        url.protocol = "ws:"
        const Socket = WebSocket as unknown as {
          new (url: URL, options: { headers: Record<string, string> }): WebSocket
        }
        const socket = new Socket(url, { headers })
        socket.binaryType = "arraybuffer"
        sockets.set(frame.id, socket)
        socket.onopen = () => {
          void wire.send({ id: frame.id, type: "open" }).catch(stop)
        }
        socket.onmessage = (event) => {
          void wire
            .send({
              id: frame.id,
              type: "message",
              binary: typeof event.data !== "string",
              data: typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("base64"),
            })
            .catch(stop)
        }
        socket.onclose = () => {
          sockets.delete(frame.id)
          void wire.send({ id: frame.id, type: "close" }).catch(stop)
        }
        socket.onerror = () => {
          socket.close()
          void wire.send({ id: frame.id, type: "error", data: "Remote terminal connection failed" }).catch(stop)
        }
        return
      }
      const abort = new AbortController()
      requests.set(frame.id, abort)
      try {
        const response = await internal(url, {
          method: frame.method,
          headers,
          body: frame.data ? Buffer.from(frame.data, "base64") : undefined,
          signal: abort.signal,
          redirect: "manual",
        })
        const safe: Record<string, string> = {}
        for (const name of ["content-type", "content-disposition", "content-range", "accept-ranges", "etag"]) {
          const value = response.headers.get(name)
          if (value) safe[name] = value
        }
        await wire.send({ id: frame.id, type: "headers", status: response.status, headers: safe })
        if (response.body) {
          const reader = response.body.getReader()
          for (;;) {
            const { done, value: chunk } = await reader.read()
            if (done) break
            for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
              await wire.send({
                id: frame.id,
                type: "data",
                data: Buffer.from(chunk.subarray(offset, offset + 64 * 1024)).toString("base64"),
              })
            }
          }
        }
        await wire.send({ id: frame.id, type: "end" })
      } finally {
        requests.delete(frame.id)
      }
    } catch (error) {
      await wire
        .send({ id: frame.id, type: "error", data: error instanceof Error ? error.message : "Remote request failed" })
        .catch(stop)
    }
  }
  await wire.send({ id: "hello", type: "hello", version: 1, home: os.homedir() })
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
  process.on("SIGHUP", stop)
  await new Promise(() => undefined)
}
