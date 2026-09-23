import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// 验收服务使用全新数据根，不接触正在运行的应用或真实会话。
const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-workspaces-preview-"))
const port = Number(process.argv[2] ?? 4110)
Object.assign(process.env, {
  OPENSCIENCE_TEST_HOME: path.join(root, "home"),
  OPENSCIENCE_DATA_DIR: path.join(root, "data"),
  OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_DATA_HOME: path.join(root, "xdg"),
  OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENSCIENCE_DISABLE_LSP_DOWNLOAD: "true",
  OPENSCIENCE_DISABLE_MODELS_FETCH: "true",
  OPENSCIENCE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
})
await fs.mkdir(path.join(root, "home"))
const { Server } = await import("../../backend/cli/src/server/server")
const server = Server.listen({ port, cors: ["http://127.0.0.1:5180", "http://127.0.0.1:5181"] })
console.log(JSON.stringify({ url: server.url.origin, root }))
