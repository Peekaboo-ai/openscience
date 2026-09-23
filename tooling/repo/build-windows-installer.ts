import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const version = process.env.OPENSCIENCE_VERSION
if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
  throw new Error("Set OPENSCIENCE_VERSION to the exact application version before packaging")
if (process.platform !== "win32") throw new Error("Build the Windows installer on Windows")
const reuse = process.argv.includes("--reuse-runtimes")
async function run(args: string[], cwd = root, env = process.env) {
  const proc = Bun.spawn(args, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  if (await proc.exited) throw new Error(`Packaging step failed: ${args.join(" ")}`)
}
if (!reuse) {
  await run(
    [process.execPath, "run", "script/build.ts", "--target=windows-x64", "--skip-install"],
    path.join(root, "backend/cli"),
  )
  await run([
    process.execPath,
    "run",
    "tooling/repo/build-remote.ts",
    "linux-x64-baseline",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
  ])
}
const sidecar = path.join(root, "backend/cli/dist/@synsci/openscience-windows-x64/bin/openscience.exe")
const check = Bun.spawn([sidecar, "--version"], { stdout: "pipe", stderr: "pipe" })
const actual = (await new Response(check.stdout).text()).trim()
if ((await check.exited) !== 0 || actual !== version)
  throw new Error(`Sidecar version mismatch: ${actual} != ${version}`)
const desktop = path.join(root, "frontend/desktop")
await run(["node", "node_modules/electron/install.js"], desktop)
await run(
  [
    "node",
    "node_modules/electron-builder/out/cli/cli.js",
    "--config",
    "electron-builder.workspaces.mjs",
    "--win",
    "--x64",
    "--publish",
    "never",
  ],
  desktop,
  {
    ...process.env,
    OPENSCIENCE_DESKTOP_SIDECAR: sidecar,
    OPENSCIENCE_DESKTOP_REMOTE_ASSETS: path.join(root, "tooling/remote/dist"),
  },
)
const name = `OpenScience-Workspaces-${version}-windows-x64-setup.exe`
const installer = Bun.file(path.join(desktop, "dist/workspaces", name))
if (!(await installer.exists())) throw new Error("Installer was not produced")
const digest = new Bun.CryptoHasher("sha256").update(await installer.arrayBuffer()).digest("hex")
await Bun.write(`${installer.name}.sha256`, `${digest}  ${name}\n`)
await Bun.write(path.join(desktop, "dist/workspaces/安装说明.md"), Bun.file(path.join(desktop, "INSTALL.zh-CN.md")))
console.log(`Installer: ${installer.name}\nSHA-256: ${digest}`)
