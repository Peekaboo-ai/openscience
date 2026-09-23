import { Terminal } from "@xterm/headless"
import { terminalOptions } from "../src/components/terminal-options"
import { decodePtyReplay } from "@synsci/util/pty-replay"

const [base, projectID, ptyID] = process.argv.slice(2)
if (!base || !projectID || !ptyID) throw new Error("Expected gateway, project ID and PTY ID")
const terminal = new Terminal({ ...terminalOptions, allowProposedApi: true })
const url = new URL(`${base}/pty/${ptyID}/connect`)
url.protocol = "ws:"
url.searchParams.set("projectID", projectID)
url.searchParams.set("replay", "geometry-v1")
const socket = new WebSocket(url)
socket.binaryType = "arraybuffer"
let playback = Promise.resolve()
let output = ""
const sizes: unknown[] = []
const done = Promise.withResolvers<void>()
const timer = setTimeout(() => done.reject(new Error("Replay timed out")), 15_000)
socket.onopen = () => socket.send("\0")
socket.onerror = () => done.reject(new Error("Replay connection failed"))
socket.onmessage = (event) => {
  if (typeof event.data === "string") {
    output += event.data
    playback = playback.then(() => new Promise<void>((resolve) => terminal.write(event.data, resolve)))
    return
  }
  const frame = decodePtyReplay(event.data)
  if (frame?.type === "resize") {
    sizes.push(frame.size)
    playback = playback.then(() => {
      terminal.resize(frame.size.cols, frame.size.rows)
    })
  }
  if (frame?.type === "ready") void playback.then(() => done.resolve())
}
try {
  await done.promise
  console.log(
    JSON.stringify({
      sizes,
      raw: output.slice(-5000),
      screen: Array.from(
        { length: terminal.buffer.active.length },
        (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? "",
      ).filter(Boolean),
    }),
  )
} finally {
  clearTimeout(timer)
  socket.close()
  terminal.dispose()
}
