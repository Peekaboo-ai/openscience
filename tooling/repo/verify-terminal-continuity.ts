import assert from "node:assert/strict"
import { decodePtyReplay } from "../util/src/pty-replay"

const [base, projectID] = process.argv.slice(2)
if (!base || !projectID) throw new Error("Usage: verify-terminal-continuity.ts <gateway> <testProjectID>")
const headers = { "content-type": "application/json", "x-openscience-project": projectID }
async function request(route: string, init?: RequestInit) {
  const response = await fetch(base + route, { ...init, headers, proxy: "", signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`)
  return response.json()
}
const access = await request(`/project/${projectID}/access`)
assert.equal(access.sandbox.enabled, true)
const session = await request("/session", {
  method: "POST",
  body: JSON.stringify({ title: "Terminal continuity verification" }),
})
let pty: { id: string } | undefined
try {
  pty = await request("/pty", {
    method: "POST",
    body: JSON.stringify({ sessionID: session.id, title: "Terminal continuity verification" }),
  })
  const id = pty!.id
  const url = new URL(`${base}/pty/${id}/connect`)
  url.protocol = "ws:"
  url.searchParams.set("projectID", projectID)
  const socket = new WebSocket(url)
  const ready = Promise.withResolvers<void>()
  let output = ""
  socket.onopen = () => {
    socket.send("\0")
    ready.resolve()
  }
  socket.onmessage = (event) => {
    output += String(event.data)
  }
  socket.onerror = () => ready.reject(new Error("Terminal connection failed"))
  await ready.promise
  const wait = async (pattern: RegExp) => {
    const deadline = Date.now() + 20_000
    while (!pattern.test(output) && Date.now() < deadline) await Bun.sleep(50)
    assert.match(output, pattern, JSON.stringify(output.slice(-1500)))
  }
  try {
    await wait(/\$ /)
    for (const cols of [100, 52, 120, 64]) {
      await request(`/pty/${id}`, { method: "PUT", body: JSON.stringify({ size: { cols, rows: 36 } }) })
      socket.send(`stty -a; printf '\\nROW_%s_A\\nROW_%s_B\\n' ${cols} ${cols}\n`)
      await wait(new RegExp(`ROW_${cols}_B\\r?\\n`))
      assert.match(output, new RegExp(`rows 36; columns ${cols};`))
      assert.match(output, new RegExp(`ROW_${cols}_A\\r\\nROW_${cols}_B\\r\\n`))
    }
    socket.send(
      "sinfo; printf '\\nCLUSTER_%s\\n' done; conda env list; printf '\\nCONDA_%s\\n' done; stty -a; printf '\\nFINAL_%s\\n' done\n",
    )
    await wait(/FINAL_done\r?\n/)
    const bareLF = (output.match(/(?<!\r)\n/g) ?? []).length
    assert.equal(bareLF, 0, "Shell output lost carriage returns")
    assert.match(output, /PARTITION\s+AVAIL/)
    assert.match(output, /# conda environments:/)
    url.searchParams.set("replay", "geometry-v1")
    const replay = new WebSocket(url)
    replay.binaryType = "arraybuffer"
    const completed = Promise.withResolvers<void>()
    const sizes: number[] = []
    let history = ""
    const timeout = setTimeout(() => completed.reject(new Error("Geometry replay timed out")), 20_000)
    replay.onopen = () => replay.send("\0")
    replay.onmessage = (event) => {
      if (typeof event.data === "string") {
        history += event.data
        return
      }
      const frame = decodePtyReplay(event.data)
      if (!frame) {
        completed.reject(new Error("Invalid geometry replay"))
        return
      }
      if (frame.type === "ready") completed.resolve()
      else sizes.push(frame.size.cols)
    }
    replay.onerror = () => completed.reject(new Error("Geometry replay connection failed"))
    try {
      await completed.promise
      for (const cols of [100, 52, 120, 64]) {
        assert.ok(sizes.includes(cols), `Missing recorded width ${cols}`)
        assert.match(history, new RegExp(`ROW_${cols}_A\\r\\nROW_${cols}_B\\r\\n`))
      }
    } finally {
      clearTimeout(timeout)
      replay.close()
    }
    console.log(
      JSON.stringify({
        sandbox: true,
        sizes: [100, 52, 120, 64],
        bareLF,
        cluster: true,
        conda: true,
        geometryReplay: true,
      }),
    )
  } finally {
    socket.close()
  }
} finally {
  if (pty) await request(`/pty/${pty.id}`, { method: "DELETE" })
  await request(`/session/${session.id}`, { method: "DELETE" })
}
