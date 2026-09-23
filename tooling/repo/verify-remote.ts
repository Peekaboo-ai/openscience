import assert from "node:assert/strict"

const [gateway, projectID, sessionID, expectedDirectory] = process.argv.slice(2)
if (!gateway || !projectID || !sessionID)
  throw new Error("Usage: verify-remote.ts <gateway> <projectID> <sessionID> [expectedDirectory]")
const headers = { "content-type": "application/json", "x-openscience-project": projectID }
async function request(route: string, init?: RequestInit) {
  const response = await fetch(gateway + route, { ...init, headers, proxy: "", signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`)
  return response.json()
}
const health = await request("/global/health")
assert.equal(health.healthy, true)
const filesystem = await request(`/session/${sessionID}/filesystem`)
if (expectedDirectory) assert.equal(filesystem.toolDirectory, expectedDirectory)
const pty = await request("/pty", {
  method: "POST",
  body: JSON.stringify({ sessionID, title: "Remote transport verification" }),
})
try {
  if (expectedDirectory) assert.equal(pty.cwd, expectedDirectory)
  const url = new URL(`${gateway}/pty/${pty.id}/connect`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("projectID", projectID)
  const result = Promise.withResolvers<string>()
  const socket = new WebSocket(url)
  socket.binaryType = "arraybuffer"
  let output = ""
  const timer = setTimeout(
    () => result.reject(new Error(`Remote terminal response timed out: ${output.slice(-1200)}`)),
    20_000,
  )
  socket.onopen = () => {
    socket.send("\0")
    socket.send("printf '\\nREMOTE_SYSTEM='; uname -s; printf 'REMOTE_DIRECTORY='; pwd\n")
  }
  socket.onmessage = (event) => {
    output += typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)
    if (/REMOTE_SYSTEM=(Linux|Darwin)\r?\n/.test(output) && output.includes("REMOTE_DIRECTORY=/"))
      result.resolve(output)
  }
  socket.onerror = () => result.reject(new Error("Remote WebSocket failed"))
  try {
    const terminal = await result.promise
    if (expectedDirectory) assert.ok(terminal.includes(`REMOTE_DIRECTORY=${expectedDirectory}`))
    console.log(
      JSON.stringify({
        healthy: true,
        version: health.version,
        toolDirectory: filesystem.toolDirectory,
        terminalDirectory: pty.cwd,
        websocket: "passed",
      }),
    )
  } finally {
    clearTimeout(timer)
    socket.close()
  }
} finally {
  await request(`/pty/${pty.id}`, { method: "DELETE" })
}
