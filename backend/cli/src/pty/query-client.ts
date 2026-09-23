import net from "node:net"

// 此入口不加载应用配置；沙箱内客户端只转发状态参数并显示宿主查询结果。
export async function runQueryClient(args: string[]) {
  const [socketPath, command, ...options] = args
  if (!socketPath || !command) return 2
  return new Promise<number>((resolve) => {
    const socket = net.createConnection(socketPath)
    let output = ""
    let finished = false
    const done = (code: number, message?: string) => {
      if (finished) return
      finished = true
      if (message) process.stderr.write(message + "\n")
      socket.destroy()
      resolve(code)
    }
    socket.setTimeout(12_000, () => done(1, "Cluster status query timed out. Try again."))
    socket.on("connect", () => socket.write(JSON.stringify({ command, args: options }) + "\n"))
    socket.on("data", (chunk) => {
      output += chunk.toString()
      if (output.length > 512 * 1024) return done(1, "Cluster status response exceeded its limit.")
      if (!output.includes("\n")) return
      try {
        const result = JSON.parse(output.slice(0, output.indexOf("\n")))
        if (typeof result.output === "string" && result.output) process.stdout.write(result.output + "\n")
        if (result.truncated) process.stderr.write("Output truncated to 64 KiB. Narrow the query filters.\n")
        done(result.status === "ready" ? 0 : 1, result.detail)
      } catch {
        done(1, "Invalid cluster status response.")
      }
    })
    socket.on("error", () => done(1, "Cluster query connection closed. Open a new terminal and retry."))
    socket.on("close", () => done(1, "Cluster query connection closed before completion."))
  })
}

if (import.meta.main) process.exit(await runQueryClient(process.argv.slice(2)))
