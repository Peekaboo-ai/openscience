import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import z from "zod"
import { Global } from "../global"
import { SshAdapter } from "../compute/ssh/adapter"
import { PLATFORM_COMMAND, openRemoteShell, startupReply } from "./startup"

const segment = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !value.startsWith("-") && !/[\u0000-\u001f]/.test(value))
export const Target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ssh"), host_id: segment }).strict(),
  z.object({ kind: z.literal("wsl"), distro: segment, user: segment.optional() }).strict(),
  z.object({ kind: z.literal("docker"), container: segment }).strict(),
])
export type Target = z.infer<typeof Target>
export const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

export function decodeOutput(bytes: Buffer) {
  if (!bytes.includes(0)) return bytes.toString("utf8")
  // WSL 自身诊断是 UTF-16，后面的 Linux stderr 仍是 UTF-8，不能整体用一种编码读取。
  const end = bytes.lastIndexOf(Buffer.from([10, 0]))
  if (end < 0) return bytes.toString("utf16le")
  return bytes.subarray(0, end + 2).toString("utf16le") + bytes.subarray(end + 2).toString("utf8")
}

export async function transport(target: Target, signal: AbortSignal) {
  const { ComputeSettings } = await import("../server/routes/settings/compute")
  const ssh = target.kind === "ssh" ? await ComputeSettings.findSshHost(target.host_id) : undefined
  if (target.kind === "ssh" && !ssh)
    throw new Error("SSH host no longer exists. Add and test it in Settings → Compute.")
  const known = ssh
    ? await SshAdapter.known(ssh, path.join(Global.Path.data, "remote-workspaces"), { signal })
    : undefined
  const executable = ssh ? await SshAdapter.executable("ssh") : target.kind === "wsl" ? "wsl.exe" : "docker"
  function start(script: string) {
    signal.throwIfAborted()
    const args =
      ssh && known
        ? SshAdapter.argv(ssh, known, script, executable).slice(1)
        : target.kind === "wsl"
          ? ["-d", target.distro, ...(target.user ? ["-u", target.user] : []), "--exec", "sh", "-c", script]
          : target.kind === "docker"
            ? ["exec", "-i", target.container, "sh", "-c", script]
            : []
    if (ssh) {
      // 长连接建立允许高延迟网关完成握手；仅重试 TCP 建连，不重放已执行的远端命令。
      // OpenSSH 同一选项取首值，放在通用探测用的 8 秒配置之前；外层仍有超时/取消边界。
      args.unshift("-o", "ConnectTimeout=30", "-o", "ConnectionAttempts=2")
      args.splice(args.indexOf("--"), 0, "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3")
    }
    const proc = spawn(executable, args, {
      env: ssh ? SshAdapter.env() : process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const cancel = () => {
      proc.stdin.destroy()
      proc.kill()
    }
    signal.addEventListener("abort", cancel, { once: true })
    proc.once("close", () => signal.removeEventListener("abort", cancel))
    return proc
  }
  async function run(script: string, input?: Readable, timeout = 90_000) {
    const proc = start(script)
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let size = 0
    proc.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 1024 * 1024) proc.kill()
      else output.push(chunk)
    })
    proc.stderr.on("data", (chunk: Buffer) => {
      if (errors.reduce((sum, item) => sum + item.length, 0) < 8000) errors.push(chunk)
    })
    const timer = setTimeout(() => proc.kill(), timeout)
    const result = new Promise<void>((resolve, reject) => {
      proc.on("error", reject)
      proc.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                signal.aborted
                  ? "Connection cancelled"
                  : decodeOutput(Buffer.concat(errors)).trim() || "Remote command failed or timed out",
              ),
            ),
      )
    })
    try {
      await Promise.all([result, input ? pipeline(input, proc.stdin) : Promise.resolve(proc.stdin.end())])
      return Buffer.concat(output).toString().trim()
    } finally {
      clearTimeout(timer)
    }
  }
  return { start, run }
}

export async function prepare(
  target: Target,
  signal: AbortSignal,
  progress: (value: string) => void,
): Promise<ChildProcessWithoutNullStreams> {
  progress("Checking connection and remote platform…")
  const remote = await transport(target, signal)
  // 平台探测后保留 shell；缓存命中时，校验与 exec 共用一次认证，避免高延迟网关反复握手。
  const opened = await openRemoteShell(
    () => remote.start(PLATFORM_COMMAND),
    signal,
    target.kind === "ssh" ? (attempt) => progress(`Retrying SSH connection (${attempt}/3)…`) : undefined,
  )
  const proc = opened.proc
  try {
    const match = opened.platform.match(/^(Linux|Darwin) (x86_64|aarch64|arm64)$/)
    if (!match) throw new Error("Remote workspaces require Linux or macOS on x64/ARM64.")
    const os = match[1] === "Linux" ? "linux" : "darwin"
    const arch = match[2] === "x86_64" ? "x64" : "arm64"
    const name = `${os}-${arch}${os === "linux" && arch === "x64" ? "-baseline" : ""}`
    const roots = [
      process.env.OPENSCIENCE_REMOTE_ASSETS,
      path.join(path.dirname(process.execPath), "remote"),
      path.resolve(import.meta.dir, "../../../../tooling/remote/dist"),
      path.resolve(import.meta.dir, "../../dist/headless"),
    ].filter((value): value is string => !!value)
    const candidates = roots.flatMap((root) => [
      path.join(root, name, "openscience"),
      path.join(root, "@synsci", `openscience-${name}`, "bin", "openscience"),
    ])
    let artifact = ""
    for (const candidate of candidates)
      if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) {
        artifact = candidate
        break
      }
    if (!artifact)
      throw new Error(
        `This installation has no ${name} remote backend. Build and package the matching remote runtime before connecting.`,
      )
    const bytes = Bun.file(artifact)
    const hash = new Bun.CryptoHasher("sha256").update(await bytes.arrayBuffer()).digest("hex")
    const directory = `"$HOME/.openscience/remote/${hash}"`
    const binary = `${directory}/openscience`
    progress("Checking remote backend version…")
    const check = `actual=''; if [ -f ${binary} ]; then actual=$( (sha256sum ${binary} 2>/dev/null || shasum -a 256 ${binary}) | cut -d ' ' -f 1); fi; printf '\\nOPENSCIENCE_CACHE %s\\n' "$actual"`
    if ((await startupReply(proc, "OPENSCIENCE_CACHE ", signal, check)) !== hash) {
      progress(`Installing remote backend (${Math.ceil(bytes.size / 1024 / 1024)} MiB)…`)
      const tmp = `${directory}/upload-${crypto.randomUUID()}`
      // 内容寻址、独占临时文件与校验后重命名保证失败上传不会替换可用版本。
      const script = `set -eu; umask 077; mkdir -p ${directory}; trap 'rm -f ${tmp}' EXIT; cat > ${tmp}; actual=$( (sha256sum ${tmp} 2>/dev/null || shasum -a 256 ${tmp}) | cut -d ' ' -f 1); [ "$actual" = ${quote(hash)} ]; chmod 700 ${tmp}; mv ${tmp} ${binary}`
      await remote.run(script, createReadStream(artifact), 15 * 60_000)
    }
    signal.throwIfAborted()
    progress("Starting remote backend and waiting for handshake…")
    proc.stdin.write(
      `export OPENSCIENCE_DATA_DIR="$HOME/.openscience/workspaces/data" OPENSCIENCE_CONFIG_DIR="$HOME/.openscience/workspaces/config"; exec ${binary} workspace-bridge\n`,
    )
    return proc
  } catch (error) {
    proc.stdin.destroy()
    proc.kill()
    throw error
  }
}

export async function listEnvironment(command: string, args: string[]) {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const timer = setTimeout(() => proc.kill(), 8000)
  try {
    const [bytes, , code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) return []
    const buffer = Buffer.from(bytes)
    return decodeOutput(buffer)
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  } finally {
    clearTimeout(timer)
  }
}
