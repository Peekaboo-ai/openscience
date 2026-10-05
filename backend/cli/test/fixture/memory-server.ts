// 组件测试通过真实 HTTP 路由和文件存储验证行为；进程环境由调用方隔离。
import path from "node:path"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { Storage } from "../../src/storage/storage"
import { Global } from "../../src/global"
import { createMemoryRoutes } from "../../src/server/routes/settings/memory"

for (const project of [
  { id: "prj_alpha", name: "Enzyme research" },
  { id: "prj_beta", name: "Materials" },
]) {
  await Storage.write(["project", project.id], {
    ...project,
    worktree: path.join(Global.Path.data, project.id),
    time: { created: 1, updated: 1, activity: 1 },
    sandboxes: [],
  })
}
for (const session of [
  { id: "ses_alpha", title: "Catalysis analysis", projectID: "prj_alpha" },
  { id: "ses_peer", title: "Another analysis", projectID: "prj_alpha" },
  { id: "ses_beta", title: "Materials study", projectID: "prj_beta" },
]) {
  await Storage.write(["session", session.projectID, session.id], { ...session, time: { updated: 1, created: 1 } })
}
const app = new Hono().use("*", cors()).route("/settings/memory", createMemoryRoutes())
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
console.log(
  `MEMORY_TEST_READY:${JSON.stringify({ url: `http://127.0.0.1:${server.port}`, filepath: path.join(Global.Path.data, "memory.json") })}`,
)
