import path from "node:path"
import fs from "node:fs/promises"

// 远端运行时独立存放，避免本机 UI 构建清空 backend/cli/dist 时误删已经生成的目标程序。
const root = path.resolve(import.meta.dir, "../..")
const targets = process.argv.slice(2)
if (!targets.length) targets.push("linux-x64-baseline")
for (const target of targets) {
  if (!["linux-x64-baseline", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(target))
    throw new Error(`Unsupported remote target: ${target}`)
  const proc = Bun.spawn(
    [process.execPath, "run", "script/build.ts", "--headless", `--target=${target}`, "--skip-install"],
    { cwd: path.join(root, "backend/cli"), stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  )
  if (await proc.exited) throw new Error(`Remote build failed: ${target}`)
  const source = path.join(root, "backend/cli/dist/headless/@synsci", `openscience-${target}`, "bin/openscience")
  const destination = path.join(root, "tooling/remote/dist", target)
  await fs.mkdir(destination, { recursive: true })
  await fs.copyFile(source, path.join(destination, "openscience"))
  console.log(`Packaged remote backend: ${destination}`)
}
