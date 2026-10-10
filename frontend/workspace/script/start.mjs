import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import { build, preview } from "vite"

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3000" },
    server: { type: "string" },
  },
})
const port = Number(values.port)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be between 1 and 65535")
const api = new URL(
  values.server ||
    process.env.VITE_OPENSCIENCE_SERVER_URL ||
    `http://${process.env.VITE_OPENSCIENCE_SERVER_HOST || "localhost"}:${process.env.VITE_OPENSCIENCE_SERVER_PORT || "4096"}`,
)
if (!["http:", "https:"].includes(api.protocol)) throw new Error("--server must use http or https")

const config = {
  root: fileURLToPath(new URL("../", import.meta.url)),
  define: { "import.meta.env.VITE_OPENSCIENCE_SERVER_URL": JSON.stringify(api.href.replace(/\/+$/, "")) },
  // 日常使用不注入 HMR 客户端，避免后台连接恢复时强制刷新；独立产物不覆盖 CLI 嵌入包。
  build: { outDir: "node_modules/.cache/workspace-preview", emptyOutDir: true },
  preview: { host: "127.0.0.1", port, strictPort: true },
}

await build(config)
const server = await preview(config)
server.printUrls()
