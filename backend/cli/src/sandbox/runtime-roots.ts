import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// 依赖安装标记而非用户名或固定安装目录；只开放安装所需的只读子树。
export function discoverRuntimeRoots(
  env: NodeJS.ProcessEnv,
  entrypoints: string[] = [],
  options: { condaEnvironments?: boolean } = {},
) {
  const roots = new Set<string>()
  const home = os.homedir()
  const add = (value: string) => {
    if (!path.isAbsolute(value)) return
    const normalized = path.normalize(value)
    if (normalized === path.parse(normalized).root || normalized === home || home.startsWith(normalized + path.sep))
      return
    if (["/etc", "/var", "/tmp", "/opt", "/usr", "/run"].includes(normalized)) return
    if (fs.existsSync(normalized)) roots.add(normalized)
  }
  const inspect = (directory: string) => {
    if (!path.isAbsolute(directory)) return
    const base = path.basename(directory).toLowerCase()
    if (!["bin", "sbin", "condabin", "scripts"].includes(base)) return
    const prefix = path.dirname(directory)
    const conda = fs.existsSync(path.join(prefix, "conda-meta"))
    const python = fs.existsSync(path.join(prefix, "pyvenv.cfg"))
    if (conda || python) {
      // 不挂载整个 Conda 根目录，避免顺带开放所有未选中的环境与用户文件。
      for (const part of [
        "bin",
        "Scripts",
        "condabin",
        "lib",
        "lib64",
        "Lib",
        "DLLs",
        "Library",
        "share",
        "conda-meta",
        "pyvenv.cfg",
        "etc/profile.d",
        "etc/conda",
      ])
        add(path.join(prefix, part))
      if (conda) {
        const registry = path.join(home, ".conda", "environments.txt")
        add(registry)
        const environment = (prefix: string) => {
          const history = path.join(prefix, "conda-meta", "history")
          if (!fs.existsSync(history)) return
          add(history)
          // 交互终端需要切换已安装环境；只开放运行库/激活脚本，仍不授予整个环境父目录。
          if (options.condaEnvironments)
            for (const part of [
              "bin",
              "Scripts",
              "lib",
              "lib64",
              "Lib",
              "DLLs",
              "Library",
              "share",
              "conda-meta",
              "etc/conda",
              "etc/profile.d",
            ])
              add(path.join(prefix, part))
        }
        try {
          if (fs.statSync(registry).size <= 64 * 1024)
            for (const item of fs.readFileSync(registry, "utf8").split(/\r?\n/).slice(0, 256))
              if (path.isAbsolute(item.trim())) environment(item.trim())
        } catch {
          // 未创建注册表时，仍可枚举当前 Conda 安装下的环境。
        }
        try {
          for (const item of fs.readdirSync(path.join(prefix, "envs")).slice(0, 256))
            environment(path.join(prefix, "envs", item))
        } catch {
          // 独立环境或尚未创建 envs 目录均是正常情况。
        }
      }
    }
    // PATH 中的自定义软件常用同一前缀的 lib/lib64；不读取项目的父目录或全盘。
    for (const part of ["lib", "lib64"]) add(path.join(prefix, part))
  }
  const locations = [
    ...(env.PATH ?? "").split(path.delimiter),
    ...entrypoints.filter(path.isAbsolute).map((file) => path.dirname(file)),
    ...[env.CONDA_PREFIX, env.VIRTUAL_ENV]
      .filter((value): value is string => !!value)
      .map((prefix) => path.join(prefix, "bin")),
  ]
  for (const directory of locations) {
    inspect(directory)
    try {
      inspect(fs.realpathSync(directory))
    } catch {
      // PATH 中的失效路径应跳过，不扩大可读范围。
    }
  }
  for (const variable of ["LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"])
    for (const directory of (env[variable] ?? "").split(path.delimiter)) add(directory)
  return [...roots]
}
