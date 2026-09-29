import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { channel, forwardedHeaders, LIMIT, type Frame } from "./protocol"
import { Log } from "../util/log"

const log = Log.create({ service: "remote.client" })

export class RemoteClient {
  private pending = new Map<string, (frame: Frame) => void>()
  private stopped = false
  private greeting = Promise.withResolvers<string>()
  private wire: ReturnType<typeof channel>
  readonly ready = this.greeting.promise

  constructor(
    readonly process: ChildProcessWithoutNullStreams,
    readonly onClose: (error: Error) => void,
  ) {
    let greeted = false
    let diagnostic = ""
    this.wire = channel(
      process.stdout,
      process.stdin,
      (frame) => {
        if (frame.type === "hello") {
          if (frame.version !== 1 || !frame.home) return this.close(new Error("Incompatible remote backend"))
          this.greeting.resolve(frame.home)
          greeted = true
          diagnostic = ""
          return
        }
        const receive = this.pending.get(frame.id)
        if (!receive) return
        try {
          receive(frame)
        } catch (error) {
          // 单个已取消响应/终端的回调异常不能关闭其他会话的共用 SSH 通道。
          this.pending.delete(frame.id)
          log.error("remote response delivery failed", { id: frame.id, error })
          void this.wire.send({ id: frame.id, type: "cancel" }).catch(() => undefined)
        }
      },
      (error) => this.close(error),
    )
    // 启动探测交接时暂停了 stdout；协议监听安装完成后再读取缓存中的 hello。
    process.stdout.resume()
    process.on("error", (error) => this.close(error))
    process.on("close", () =>
      this.close(
        new Error(
          `Remote backend exited; reconnect to continue${!greeted && diagnostic.trim() ? `: ${diagnostic.trim()}` : ""}`,
        ),
      ),
    )
    // stderr 只用于有界诊断，不混入协议，也不记录远端用户文件或凭据。
    process.stderr.on("data", (value: Buffer) => {
      if (!greeted) diagnostic = (diagnostic + value.toString()).slice(-2000)
    })
    void this.ready.catch(() => undefined)
  }

  close(error = new Error("Remote connection disconnected")) {
    if (this.stopped) return
    this.stopped = true
    this.greeting.reject(error)
    for (const [id, receive] of this.pending) {
      try {
        receive({ id, type: "error", data: error.message })
      } catch (failure) {
        log.error("remote response shutdown failed", { id, error: failure })
      }
    }
    this.pending.clear()
    this.process.stdin.end()
    const timer = setTimeout(() => this.process.kill(), 10_000)
    timer.unref()
    this.process.once("close", () => clearTimeout(timer))
    this.onClose(error)
  }

  async request(path: string, init: RequestInit = {}) {
    if (this.stopped) throw new Error("Remote connection is offline")
    const id = crypto.randomUUID()
    const body = init.body ? await new Response(init.body).arrayBuffer() : undefined
    if (body && body.byteLength > LIMIT / 2) throw new Error("Remote request is larger than 16 MiB")
    const result = Promise.withResolvers<Response>()
    // 传输写入期间就可能收到取消；调用方仍会收到原拒绝，先注册观察者避免提前未处理拒绝。
    void result.promise.catch(() => undefined)
    let finished = false
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const finish = () => {
      finished = true
      this.pending.delete(id)
      clearTimeout(timer)
      init.signal?.removeEventListener("abort", abort)
    }
    const cancel = (bodyCancelled = false) => {
      if (finished) return
      finish()
      result.reject(new Error("Remote request cancelled"))
      // 页面离开是正常关闭。向 Bun 已取消的 HTTP 响应再次注入流错误会导致未处理拒绝。
      if (!bodyCancelled) controller?.close()
      void this.wire.send({ id, type: "cancel" }).catch(() => undefined)
    }
    const abort = () => cancel()
    const fail = (error: Error) => {
      if (finished) return
      finish()
      result.reject(error)
      controller?.error(error)
      void this.wire.send({ id, type: "cancel" }).catch(() => undefined)
    }
    const timer = setTimeout(() => fail(new Error("Remote request timed out")), 120_000)
    const receive = (frame: Frame) => {
      if (finished) return
      if (frame.type === "headers") {
        // 先验证响应头，避免构造 Response 失败后留下无人消费的错误流。
        const options = { status: frame.status, headers: frame.headers }
        new Response(null, options)
        // 收到响应头后才创建响应体，连接失败时不会遗留无人消费的错误流。
        const empty = [204, 205, 304].includes(frame.status ?? 200) || init.method === "HEAD"
        const stream = empty
          ? null
          : new ReadableStream<Uint8Array>({
              start(value) {
                controller = value
              },
              cancel: () => cancel(true),
            })
        result.resolve(new Response(stream, options))
        clearTimeout(timer)
      }
      if (frame.type === "data") {
        if ((controller?.desiredSize ?? 0) < -512) return fail(new Error("Remote response buffering limit exceeded"))
        controller?.enqueue(Buffer.from(frame.data ?? "", "base64"))
      }
      if (frame.type === "end") {
        finish()
        controller?.close()
      }
      if (frame.type === "error") {
        fail(new Error(frame.data))
      }
    }
    this.pending.set(id, (frame) => {
      try {
        receive(frame)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    init.signal?.addEventListener("abort", abort, { once: true })
    if (init.signal?.aborted) abort()
    else
      await this.wire
        .send({
          id,
          type: "request",
          path,
          method: init.method ?? "GET",
          headers: forwardedHeaders(new Headers(init.headers)),
          data: body ? Buffer.from(body).toString("base64") : undefined,
        })
        .catch(fail)
    return result.promise
  }

  socket(path: string, receive: (frame: Frame) => void) {
    if (this.stopped) throw new Error("Remote connection is offline")
    const id = crypto.randomUUID()
    let opened = false
    let closed = false
    let size = 0
    const queue: Omit<Frame, "id">[] = []
    const notify = (frame: Frame) => {
      try {
        receive(frame)
      } catch (error) {
        closed = true
        queue.length = 0
        this.pending.delete(id)
        log.error("remote socket delivery failed", { id, error })
        void this.wire.send({ id, type: "cancel" }).catch(() => undefined)
      }
    }
    const send = (frame: Omit<Frame, "id">) => {
      void this.wire.send({ ...frame, id }).catch(() => {
        this.pending.delete(id)
        closed = true
        notify({ id, type: "error" })
      })
    }
    this.pending.set(id, (frame) => {
      if (frame.type === "open") {
        opened = true
        for (const queued of queue) send(queued)
        queue.length = 0
        size = 0
      }
      if (frame.type === "close" || frame.type === "error") {
        closed = true
        this.pending.delete(id)
        queue.length = 0
      }
      notify(frame)
    })
    send({ type: "ws", path })
    return {
      send: (data: string | ArrayBuffer) => {
        if (closed) return
        const frame = {
          type: "message" as const,
          binary: typeof data !== "string",
          data: typeof data === "string" ? data : Buffer.from(data).toString("base64"),
        }
        if (opened) {
          send(frame)
          return
        }
        // 浏览器握手比远端 PTY 快，先缓存有限输入，防止首条终端命令丢失。
        size += frame.data.length
        if (size > 1024 * 1024) {
          closed = true
          this.pending.delete(id)
          send({ type: "close" })
          notify({ id, type: "error", data: "Remote terminal input queue is full" })
          return
        }
        queue.push(frame)
      },
      close: () => {
        closed = true
        queue.length = 0
        this.pending.delete(id)
        send({ type: "close" })
      },
    }
  }
}
