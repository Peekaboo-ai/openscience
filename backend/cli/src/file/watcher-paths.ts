import path from "node:path"

export function runtimeWatchIgnores(root: string, internal: string[]) {
  // 只排除监听根内的运行目录；显式监听其下的科研项目或会话 scratch 时仍保留文件更新。
  return [...new Set(internal.map((entry) => path.resolve(entry)))].filter((entry) => {
    const relative = path.relative(root, entry)
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  })
}
