import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import net from "node:net"
import { once } from "node:events"
import os from "node:os"
import path from "node:path"
import { SshAdapter } from "../../src/compute/ssh/adapter"
import { sshConfigTokens } from "../../src/compute/ssh/config-tokens"

test("keeps Windows drive, UNC and relative paths including quoted spaces", () => {
  for (const value of [
    String.raw`C:\Users\Lenovo\.ssh\identity.txt`,
    String.raw`C:\Research Keys\identity.txt`,
    String.raw`\\server\share\Research Keys\identity.txt`,
    String.raw`.ssh\identity.txt`,
    String.raw`conf\*.conf`,
  ]) {
    expect(sshConfigTokens(`"${value}" # comment`, "win32")).toEqual([value])
    expect(sshConfigTokens(`'${value}'`, "win32")).toEqual([value])
    if (!value.includes(" ")) expect(sshConfigTokens(value, "win32")).toEqual([value])
  }
  expect(sshConfigTokens('"C:/Research Keys/identity.txt"', "win32")).toEqual(["C:/Research Keys/identity.txt"])
})

test("retains POSIX escaping, comments and multiple Include tokens", () => {
  expect(sshConfigTokens(String.raw`/keys/research\ key /keys/other\#key # comment`, "linux")).toEqual([
    "/keys/research key",
    "/keys/other#key",
  ])
  expect(sshConfigTokens(String.raw`"/keys/a\"b" 'conf/with space/*' conf/*.conf`, "linux")).toEqual([
    '/keys/a"b',
    "conf/with space/*",
    "conf/*.conf",
  ])
})

test("SSH environment retains Windows runtime variables without credentials or executable hooks", () => {
  const env = SshAdapter.env(
    {
      Path: "first",
      PATH: "last",
      ProgramData: "C:\\ProgramData",
      SystemRoot: "C:\\Windows",
      UserProfile: "C:\\Users\\Test",
      Temp: "C:\\Temp",
      SSH_AUTH_SOCK: "agent",
      OPENAI_API_KEY: "secret",
      MODAL_TOKEN_SECRET: "secret",
      SSH_ASKPASS: "untrusted",
      NODE_OPTIONS: "untrusted",
      LD_PRELOAD: "untrusted",
      GIT_CONFIG_GLOBAL: "untrusted",
      OPENSCIENCE_DESKTOP_PARENT_TOKEN: "secret",
    },
    "win32",
  )
  expect(env).toEqual({
    PATH: "last",
    PROGRAMDATA: "C:\\ProgramData",
    SYSTEMROOT: "C:\\Windows",
    USERPROFILE: "C:\\Users\\Test",
    TEMP: "C:\\Temp",
    SSH_AUTH_SOCK: "agent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_TERMINAL_PROMPT: "0",
  })
  expect(
    SshAdapter.env({ PATH: "/bin", Path: "other", ProgramData: "windows", SSH_AUTH_SOCK: "/agent" }, "linux"),
  ).toEqual({
    PATH: "/bin",
    SSH_AUTH_SOCK: "/agent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  })
})

test("Windows OpenSSH can fingerprint a real host key using the transport environment", async () => {
  if (process.platform !== "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-windows-"))
  try {
    const keygen = await SshAdapter.executable("ssh-keygen")
    const key = path.join(root, "host-key")
    const generated = spawnSync(keygen, ["-q", "-t", "ed25519", "-N", "", "-f", key], { encoding: "utf8" })
    expect(generated.status).toBe(0)
    const identified = spawnSync(keygen, ["-lf", `${key}.pub`, "-E", "sha256"], { encoding: "utf8" })
    expect(identified.status).toBe(0)
    const fingerprint = identified.stdout.trim().split(/\s+/)[1]!
    const publicKey = (await fs.readFile(`${key}.pub`, "utf8")).trim().split(/\s+/).slice(0, 2).join(" ")
    const known = await SshAdapter.known(
      {
        id: "test",
        label: "Test",
        host: "example.invalid",
        scheduler: "none",
        host_key: `example.invalid ${publicKey}`,
        fingerprint,
      },
      root,
    )
    expect(await fs.readFile(known, "utf8")).toContain(publicKey)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("OpenSSH loads one pinned file from a Unicode path with spaces for direct and jump-host configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience ssh 用户 "))
  // 只提供握手横幅，让真实 OpenSSH 读取本地密钥并生成协商列表；不依赖外网或安装 sshd。
  const server = net.createServer((socket) => {
    socket.on("error", () => {})
    socket.write("SSH-2.0-OpenScienceFixture\r\n")
    socket.on("data", (chunk) => {
      if (chunk.includes(0)) socket.end()
    })
    socket.setTimeout(5_000, () => socket.destroy())
  })
  try {
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing SSH fixture address")
    const ssh = await SshAdapter.executable("ssh")
    const keygen = await SshAdapter.executable("ssh-keygen")
    const key = path.join(root, "host key")
    expect(spawnSync(keygen, ["-q", "-t", "ed25519", "-N", "", "-f", key]).status).toBe(0)
    const identified = spawnSync(keygen, ["-lf", `${key}.pub`, "-E", "sha256"], { encoding: "utf8" })
    expect(identified.status).toBe(0)
    const publicKey = (await fs.readFile(`${key}.pub`, "utf8")).trim().split(/\s+/).slice(0, 2).join(" ")
    const host: SshAdapter.Host = {
      id: "space-path",
      label: "Path fixture",
      host: "127.0.0.1",
      port: address.port,
      identity_file: key,
      scheduler: "none",
      host_key: `[127.0.0.1]:${address.port} ${publicKey}`,
      fingerprint: identified.stdout.trim().split(/\s+/)[1]!,
    }
    const known = await SshAdapter.known(host, root)
    const direct = SshAdapter.argv(host, known, "true", ssh)
    // ProxyJump 子进程依赖生成的 -F 配置；分别检验配置路径和直接连接的 -o 覆盖路径。
    const inherited = [ssh, "-F", `${known}.ssh_config`, "-p", String(address.port), host.host, "true"]
    for (const argv of [direct, inherited]) {
      const proc = Bun.spawn([argv[0]!, "-vvv", ...argv.slice(1)], {
        env: SshAdapter.env(),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        signal: AbortSignal.timeout(5_000),
      })
      const stderr = await new Response(proc.stderr).text()
      expect(await proc.exited).toBe(255)
      expect(stderr).toContain("record_hostkey: found key type ED25519 in file")
      expect(stderr).toMatch(
        new RegExp(`load_hostkeys(?:_file)?: loaded 1 keys from \\[127\\.0\\.0\\.1\\]:${address.port}`),
      )
      expect(stderr).not.toContain("No such file or directory")
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
})
