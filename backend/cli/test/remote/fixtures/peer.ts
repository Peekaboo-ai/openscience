import { channel, PREFIX } from "../../../src/remote/protocol"

if (process.argv.includes("--no-read")) {
  process.stdout.write(PREFIX + JSON.stringify({ id: "hello", type: "hello", version: 1, home: "/test" }) + "\n")
  setInterval(() => undefined, 1000)
  await new Promise(() => undefined)
}

const wire = channel(
  process.stdin,
  process.stdout,
  (frame) => {
    const send = (value: Parameters<typeof wire.send>[0]) => void wire.send(value).catch(() => undefined)
    if (frame.type === "ws") {
      send({ id: frame.id, type: "open" })
      send({ id: frame.id, type: "message", data: "late terminal output" })
      return
    }
    if (frame.type !== "request") return
    if (frame.path === "/failure") return send({ id: frame.id, type: "error", data: "Request failed before headers" })
    if (frame.path === "/invalid") return send({ id: frame.id, type: "headers", status: 100 })
    const reply = () => {
      send({ id: frame.id, type: "headers", status: 200 })
      send({ id: frame.id, type: "data", data: Buffer.from("healthy").toString("base64") })
      send({ id: frame.id, type: "end" })
    }
    if (frame.path === "/slow") setTimeout(reply, 60)
    else reply()
  },
  () => process.exit(0),
)
await wire.send({ id: "hello", type: "hello", version: 1, home: "/test" })
