import assert from "node:assert/strict"
import { prepare, Target } from "../../backend/cli/src/remote/transport"
import { RemoteClient } from "../../backend/cli/src/remote/client"

// 手动运行真实传输验收，不要求 CI 主机安装 WSL、Docker 或持有 SSH 私钥。
const target = Target.parse(JSON.parse(process.argv[2] ?? "{}"))
const abort = new AbortController()
const timer = setTimeout(() => abort.abort(), 15 * 60_000)
try {
  const proc = await prepare(target, abort.signal, console.log)
  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()))
  const client = new RemoteClient(proc, () => undefined)
  const handshake = setTimeout(() => client.close(new Error("Handshake timed out")), 90_000)
  try {
    const directory = await client.ready
    const health = await client.request("/global/health").then((res) => res.json())
    assert.equal(health.healthy, true)
    const listing = await client.request("/workspace/directories").then((res) => res.json())
    assert.equal(listing.directory, directory)
    console.log(JSON.stringify({ transport: target.kind, healthy: true, version: health.version, directory }))
  } finally {
    clearTimeout(handshake)
    client.close()
    await closed
  }
} finally {
  clearTimeout(timer)
}
