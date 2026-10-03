import { expect, spyOn, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { RemoteClient } from "../../src/remote/client"

test("cancelled requests and failed terminal subscribers do not tear down the shared connection", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/peer.ts", import.meta.url))], {
    stdio: "pipe",
  })
  const exited = once(child, "close")
  let closed = 0
  const client = new RemoteClient(child, () => {
    closed++
  })
  try {
    await client.ready
    // 先等待真实 I/O 结束再断言，避免 Bun 的 pending-rejection 断言阻塞子进程回调。
    const failure = await client.request("/failure").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("before headers")
    const invalid = await client.request("/invalid").catch((error: unknown) => error)
    expect(invalid).toBeInstanceOf(Error)
    const abort = new AbortController()
    const cancelled = client.request("/slow", { signal: abort.signal })
    abort.abort()
    const cancellation = await cancelled.catch((error: unknown) => error)
    expect(cancellation).toBeInstanceOf(Error)
    expect((cancellation as Error).message).toContain("cancelled")
    const socket = client.socket("/terminal", () => {
      throw new Error("Already removed subscriber")
    })
    await Bun.sleep(100)
    const healthy = await client.request("/health")
    expect(await healthy.text()).toBe("healthy")
    expect(closed).toBe(0)
    socket.close()
  } finally {
    client.close()
    await exited
  }
}, 15_000)

test.each(["cancelled", "disconnected"])(
  "%s requests settle while SSH is blocked writing",
  async (reason) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/peer.ts", import.meta.url)), "--no-read"],
      {
        stdio: "pipe",
        windowsHide: true,
      },
    )
    const exited = once(child, "close")
    const client = new RemoteClient(child, () => undefined)
    try {
      await client.ready
      using writing = spyOn(child.stdin, "write")
      const controller = new AbortController()
      const pending = client
        .request("/blocked", { method: "POST", body: "x".repeat(8 * 1024 * 1024), signal: controller.signal })
        .catch((error: unknown) => error)
      const deadline = Date.now() + 2000
      while (!writing.mock.calls.length && Date.now() < deadline) await Bun.sleep(5)
      expect(writing.mock.calls.length).toBe(1)
      if (reason === "cancelled") controller.abort()
      else client.close()
      const timeout = Promise.withResolvers<never>()
      const timer = setTimeout(() => timeout.reject(new Error("Cancelled request is still waiting for SSH")), 1000)
      try {
        const result = await Promise.race([pending, timeout.promise])
        expect(result).toBeInstanceOf(Error)
        expect((result as Error).message).toContain(reason)
      } finally {
        clearTimeout(timer)
      }
    } finally {
      client.close()
      child.kill()
      await exited
    }
  },
  15_000,
)
