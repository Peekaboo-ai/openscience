import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// 固定后端启动目录，避免项目实例切换改变留空目录的含义。
export const workspaceDirectory = process.cwd()

export function folderName(value: string) {
  const name = value.trim()
  if (!name || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name))
    throw new Error("Use a single folder name without slashes or control characters.")
  if (
    process.platform === "win32" &&
    (/[<>:"|?*]|[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
  )
    throw new Error("This folder name is not supported on Windows.")
  return name
}

export async function resolveDirectory(value: string) {
  const expanded =
    value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value
  const directory = await fs.realpath(path.resolve(workspaceDirectory, expanded))
  if (!(await fs.stat(directory)).isDirectory()) throw new Error("Choose an existing directory.")
  return directory
}

export async function createDirectory(parent: string, name: string) {
  const directory = path.join(await resolveDirectory(parent), folderName(name))
  // mkdir 不递归、不覆盖：同名文件、符号链接或权限问题交由界面明确反馈。
  await fs.mkdir(directory)
  return resolveDirectory(directory)
}

export async function projectDirectory(input: { directory?: string; name: string }, base = workspaceDirectory) {
  if (input.directory?.trim()) return resolveDirectory(input.directory.trim())
  const directory = path.join(await resolveDirectory(base), folderName(input.name))
  await fs.mkdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  return resolveDirectory(directory)
}
