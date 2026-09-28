import fs from "node:fs/promises"
import path from "node:path"

/** Bun/Windows 的递归 rm 未可靠执行 maxRetries；原生句柄释放后做有界重试。
 * 仅用于已完成 runtime disposal 的测试临时目录，最终失败必须保留。 */
export async function removeFixture(directory: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(path.toNamespacedPath(directory), { recursive: true, force: true })
      return
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= 10 ||
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        !["EBUSY", "ENOTEMPTY", "EPERM"].includes(String(error.code))
      )
        throw error
      await Bun.sleep(100)
    }
  }
}
