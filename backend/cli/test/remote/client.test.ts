import { expect, test } from "bun:test"
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
