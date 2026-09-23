import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { terminalArgs } from "./environment"
import { discoverRuntimeRoots } from "../sandbox/runtime-roots"

export async function terminalInitialization(command: string, env: Record<string, string>) {
  const shell = path.basename(command).replace(/\.exe$/i, "")
  const conda = Bun.which("conda", { PATH: env.PATH })
  if (!conda || !["bash", "zsh", "fish", "sh", "dash", "ksh"].includes(shell))
    return { args: terminalArgs(command), readable: [] as string[], close: () => {} }
  const executable = await fs.realpath(conda)
  const prefix = path.dirname(path.dirname(executable))
  const hook = path.join(prefix, shell === "fish" ? "etc/fish/conf.d/conda.fish" : "etc/profile.d/conda.sh")
  if (!(await fs.stat(hook).catch(() => undefined))?.isFile())
    return { args: terminalArgs(command), readable: [] as string[], close: () => {} }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osc-shell-"))
  const rc = path.join(root, shell === "zsh" ? ".zshrc" : "init")
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
  // 仅在交互 shell 内加载安装自带 hook，不执行 conda init、不修改用户 dotfiles。
  const initial = env.CONDA_PREFIX
  const script = `. ${quote(hook)}\n${initial ? `conda activate ${quote(initial)}\n` : ""}`
  try {
    await fs.chmod(root, 0o700)
    await fs.writeFile(rc, shell === "fish" ? `source ${quote(hook)}\n` : script, { mode: 0o400 })
    if (shell === "zsh") env.ZDOTDIR = root
    if (["sh", "dash", "ksh"].includes(shell)) env.ENV = rc
    const args =
      shell === "bash"
        ? ["--noprofile", "--rcfile", rc, "-O", "checkwinsize", "-i"]
        : shell === "zsh"
          ? ["-d", "-i"]
          : shell === "fish"
            ? ["--no-config", "--interactive", "--init-command", `source ${quote(rc)}`]
            : ["-i"]
    return {
      args,
      readable: [root, hook, ...discoverRuntimeRoots(process.env, [executable], { condaEnvironments: true })],
      close: () => {
        void fs
          .rm(root, { recursive: true, force: true })
          .catch((error) => console.error("Terminal initialization cleanup failed", error))
      },
    }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
}
