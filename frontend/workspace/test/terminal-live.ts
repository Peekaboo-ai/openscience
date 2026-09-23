import assert from "node:assert/strict"
import { Terminal } from "@xterm/headless"
import { terminalOptions } from "../src/components/terminal-options"
import { decodePtyReplay } from "@synsci/util/pty-replay"

const [base, projectID] = process.argv.slice(2)
if (!base || !projectID) throw new Error("Expected gateway and dedicated regression project ID")
const headers = { "content-type": "application/json", "x-openscience-project": projectID }
async function request(route: string, body?: unknown, method = body ? "POST" : "GET") {
  const response = await fetch(base + route, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    proxy: "",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`)
  return response.json()
}
const session = await request("/session", { title: "Long input and readline regression" })
const terminal = new Terminal({ ...terminalOptions, cols: 80, rows: 30, allowProposedApi: true })
let pty: { id: string } | undefined
let socket: WebSocket | undefined
let removed = false
let output = ""
let playback = Promise.resolve()
const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 25_000
  while (!predicate() && Date.now() < deadline) await Bun.sleep(30)
  await playback
  assert.ok(predicate(), output.slice(-2500))
}
const screen = () =>
  Array.from(
    { length: terminal.buffer.active.length },
    (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? "",
  ).join("\n")
try {
  pty = await request("/pty", { sessionID: session.id, title: "Readline regression" })
  // 模拟浏览器：创建后立即同步尺寸，不能等待提示符后才验证而漏掉启动竞态。
  terminal.resize(66, 45)
  await request(`/pty/${pty!.id}`, { size: { cols: 66, rows: 45 } }, "PUT")
  const url = new URL(`${base}/pty/${pty!.id}/connect`)
  url.protocol = "ws:"
  url.searchParams.set("projectID", projectID)
  url.searchParams.set("replay", "geometry-v1")
  socket = new WebSocket(url)
  socket.binaryType = "arraybuffer"
  const ready = Promise.withResolvers<void>()
  socket.onopen = () => socket!.send("\0")
  socket.onerror = () => ready.reject(new Error("WebSocket failed"))
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") {
      const frame = decodePtyReplay(event.data)
      if (frame?.type === "ready") ready.resolve()
      if (frame?.type === "resize")
        playback = playback.then(() => {
          terminal.resize(frame.size.cols, frame.size.rows)
        })
      return
    }
    output += event.data
    playback = playback.then(() => new Promise<void>((resolve) => terminal.write(event.data, resolve)))
  }
  await ready.promise
  await wait(() => output.includes("$ "))
  socket.send('stty size; printf \'STARTUP_%s_%s\\n\' "$COLUMNS" "$LINES"\r')
  await wait(() => output.includes("STARTUP_"))
  await wait(() => /STARTUP_\d+_\d+\r\n/.test(output))
  assert.ok(
    output.includes("45 66\r\n") && output.includes("STARTUP_66_45\r\n"),
    `Initial geometry mismatch: ${JSON.stringify(output)}`,
  )
  for (const cols of [52, 100, 42, 80]) {
    terminal.resize(cols, 30)
    await request(`/pty/${pty!.id}`, { size: { cols, rows: 30 } }, "PUT")
    socket.send(`printf '\\nSIZE_%s_%s_%s\\n' ${cols} "$COLUMNS" "$LINES"\r`)
    await wait(() => output.includes(`SIZE_${cols}_${cols}_30\r\n`))
    // 分段输入并在执行前检查屏幕，验证 readline 没把后半段画回提示符开头。
    const text = `printf '%s\\n' '${"0123456789".repeat(13)}END_${cols}'`
    for (let i = 0; i < text.length; i += 7) {
      socket.send(text.slice(i, i + 7))
      await Bun.sleep(30)
    }
    await wait(() => screen().replaceAll("\n", "").includes(`END_${cols}`))
    const displayed = screen().replaceAll("\n", "")
    assert.ok(displayed.includes(text), `Input overwritten at ${cols} cols:\n${screen()}`)
    socket.send("\r")
    await wait(() => output.includes(`0123456789END_${cols}\r\n`))
  }
  const text = `printf '%s\\n' '${"resize".repeat(20)}MID_INPUT_END'`
  socket.send(text.slice(0, 70))
  await wait(() => screen().replaceAll("\n", "").includes(text.slice(0, 70)))
  terminal.resize(46, 30)
  await request(`/pty/${pty!.id}`, { size: { cols: 46, rows: 30 } }, "PUT")
  socket.send(text.slice(70))
  await wait(() => screen().replaceAll("\n", "").includes("MID_INPUT_END"))
  assert.ok(screen().replaceAll("\n", "").includes(text), `Input overwritten while resizing:\n${screen()}`)
  socket.send("\r")
  await wait(() => output.includes("resizeMID_INPUT_END\r\n"))
  socket.send("printf 'DELETE_%s\\n' ready; while :; do printf tick; sleep 0.1; done\r")
  await wait(() => output.includes("DELETE_ready\r\n"))
  await request(`/session/${session.id}`, undefined, "DELETE")
  removed = true
  await wait(() => socket?.readyState === WebSocket.CLOSED)
  assert.equal((await request("/global/health")).healthy, true)
  assert.equal(
    (await request("/pty")).some((item: { id: string }) => item.id === pty?.id),
    false,
  )
  console.log(
    JSON.stringify({
      sizes: [52, 100, 42, 80, 46],
      longInput: true,
      resizeWhileTyping: true,
      deletionDuringOutput: true,
    }),
  )
} finally {
  socket?.close()
  terminal.dispose()
  if (!removed) {
    if (pty) await request(`/pty/${pty.id}`, undefined, "DELETE")
    await request(`/session/${session.id}`, undefined, "DELETE")
  }
}
