import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"

const [source, installed] = process.argv.slice(2).map((value) => path.resolve(value))
assert.ok(source && installed, "Usage: node verify-windows-install.mjs <win-unpacked> <installed-directory>")
assert.notEqual(source, installed, "Expected an independently installed directory")

async function digest(file) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function verify(relative = "") {
  let count = 0
  for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name)
    if (entry.isDirectory()) {
      count += await verify(name)
      continue
    }
    assert.ok(entry.isFile(), `Unexpected package entry: ${name}`)
    const expected = path.join(source, name)
    const actual = path.join(installed, name)
    assert.equal((await stat(actual)).size, (await stat(expected)).size, `Truncated installed file: ${name}`)
    assert.equal(await digest(actual), await digest(expected), `Installed file mismatch: ${name}`)
    count++
  }
  return count
}

// 安装器退出码不足以证明完整解压；逐文件比较实际安装产物，覆盖压缩格式和磁盘空间导致的损坏。
const count = await verify()
assert.ok(count > 0, "The expected package is empty")
console.log(`Verified ${count} installed files against the unpacked package (SHA-256).`)
