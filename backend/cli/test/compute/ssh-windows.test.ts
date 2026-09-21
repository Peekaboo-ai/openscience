import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
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
