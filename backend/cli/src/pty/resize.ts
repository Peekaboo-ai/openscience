import fs from "node:fs"

// bwrap 的新会话不会把宿主 PTY 的 SIGWINCH 转给内层 script。
// 只沿本终端的子进程树通知桥接器，不扫描或触碰其他会话。
export function relayTerminalResize(root: number) {
  if (process.platform !== "linux") return
  const read = (pid: number) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
      const end = stat.lastIndexOf(")")
      const fields = stat.slice(end + 2).split(" ")
      return { name: stat.slice(stat.indexOf("(") + 1, end), parent: Number(fields[1]), started: fields[19] }
    } catch {
      return undefined
    }
  }
  const leader = read(root)
  if (!leader) return
  const pending = [root]
  const visited = new Set<number>()
  while (pending.length && visited.size < 64) {
    const pid = pending.shift()!
    if (visited.has(pid)) continue
    visited.add(pid)
    let children: number[]
    try {
      children = fs
        .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((id) => id > 0)
    } catch {
      continue
    }
    for (const child of children) {
      const info = read(child)
      if (!info || info.parent !== pid) continue
      if (info.name === "script") {
        const current = read(child)
        if (read(root)?.started !== leader.started || current?.started !== info.started || current.parent !== pid)
          continue
        try {
          process.kill(child, "SIGWINCH")
        } catch {
          /* 桥接器可能刚刚退出。 */
        }
      } else pending.push(child)
    }
  }
}
