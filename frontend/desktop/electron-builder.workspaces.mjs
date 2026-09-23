import { existsSync } from "node:fs"
import path from "node:path"
import base from "./electron-builder.mjs"

const remote = process.env.OPENSCIENCE_DESKTOP_REMOTE_ASSETS
if (!remote) throw new Error("OPENSCIENCE_DESKTOP_REMOTE_ASSETS must point to the packaged remote runtimes")
const targets = ["linux-x64-baseline", "linux-arm64", "darwin-x64", "darwin-arm64"]
for (const target of targets) {
  if (!existsSync(path.join(remote, target, "openscience"))) throw new Error(`Missing remote runtime: ${target}`)
}

// 独立安装身份和数据目录避免定制版升级、卸载影响原版或已有开发服务。
export default {
  ...base,
  appId: "ai.peekaboo.openscience.workspaces",
  productName: "OpenScience Workspaces",
  executableName: "OpenScience Workspaces",
  artifactName: "OpenScience-Workspaces-${version}-windows-${arch}-setup.${ext}",
  buildVersion: `${base.extraMetadata.version.split("-")[0]}.0`,
  extraMetadata: {
    ...base.extraMetadata,
    name: "openscience-workspaces",
    productName: "OpenScience Workspaces",
    main: "src/workspaces.mjs",
  },
  directories: { output: "dist/workspaces" },
  // 桌面主进程只使用 Electron 和 Node 内置模块，排除 monorepo 根依赖及构建日志。
  files: ["src/**/*", "package.json", "!node_modules/**/*"],
  extraResources: [
    ...base.extraResources,
    ...targets.map((target) => ({
      from: path.resolve(remote, target, "openscience"),
      to: `sidecar/remote/${target}/openscience`,
    })),
    { from: "../../LICENSE", to: "LICENSE-OpenScience.txt" },
    { from: "../../NOTICE", to: "NOTICE-OpenScience.txt" },
  ],
  nsis: {
    ...base.nsis,
    include: "build/workspaces.nsh",
    // ZIP 插件直接解压到目标目录并报告错误，避免 7z 先在系统盘展开整份科学运行时。
    useZip: true,
    // electron-builder 的差分包强制使用 7z；必须同步关闭，避免 ZIP 解压器收到 7z 数据。
    differentialPackage: false,
    perMachine: false,
    allowElevation: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "OpenScience Workspaces",
    uninstallDisplayName: "OpenScience Workspaces",
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
    installerLanguages: ["en_US", "zh_CN"],
    displayLanguageSelector: true,
    license: "../../LICENSE",
  },
}
