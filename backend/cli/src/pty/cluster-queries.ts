import fs from "node:fs/promises"
import path from "node:path"
import net from "node:net"
import { ComputeEnvironment } from "../compute/environment"
import { clusterQueryCommands } from "../compute/query-arguments"

export async function createClusterQueries() {
  if (process.platform !== "linux") return undefined
  const commands = clusterQueryCommands.filter((command) => Bun.which(command))
  if (!commands.length) return undefined
  const root = await fs.mkdtemp("/tmp/osc-query-")
  await fs.chmod(root, 0o700)
  const socketPath = path.join(root, "query.sock")
  const sockets = new Set<net.Socket>()
  const operations = new Set<AbortController>()
  const server = net.createServer((socket) => {
    if (sockets.size >= 4) return socket.destroy()
    sockets.add(socket)
    const abort = new AbortController()
    let data = ""
    let started = false
    socket.setTimeout(12_000, () => socket.destroy())
    socket.on("error", () => socket.destroy())
    socket.on("close", () => {
      sockets.delete(socket)
      abort.abort()
      operations.delete(abort)
    })
    socket.on("data", (chunk) => {
      if (started) return socket.destroy()
      data += chunk.toString()
      if (data.length > 4096) return socket.destroy()
      if (!data.includes("\n")) return
      started = true
      operations.add(abort)
      void (async () => {
        try {
          const input = JSON.parse(data)
          if (
            !commands.includes(input.command) ||
            !Array.isArray(input.args) ||
            !input.args.every((item: unknown) => typeof item === "string")
          )
            throw new Error("Invalid cluster status request.")
          return await ComputeEnvironment.query(input.command, input.args, abort.signal)
        } catch (error) {
          return {
            status: "error",
            output: "",
            detail: error instanceof Error ? error.message : "Cluster status query failed.",
          }
        }
      })().then((result) => {
        if (!socket.destroyed) socket.end(JSON.stringify(result) + "\n")
      })
    })
  })
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    for (const abort of operations) abort.abort()
    for (const socket of sockets) socket.destroy()
    server.close(() => {
      void fs.rm(root, { recursive: true, force: true })
    })
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, resolve)
    })
    const source = ["bun", "bun.exe"].includes(path.basename(process.execPath).toLowerCase())
    const client = path.join(import.meta.dir, "query-client.ts")
    const invocation = source ? [process.execPath, client] : [process.execPath, "--terminal-query"]
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
    for (const command of commands) {
      await fs.writeFile(
        path.join(root, command),
        `#!/bin/sh\nexec ${[...invocation, socketPath, command].map(quote).join(" ")} "$@"\n`,
        { mode: 0o500 },
      )
    }
    return { root, readable: [root, process.execPath, ...(source ? [client] : [])], close }
  } catch (error) {
    close()
    throw error
  }
}
