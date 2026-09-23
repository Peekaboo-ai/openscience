import { mkdtemp, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// 独立的真实后端验收实例：合成会话仅写入临时目录，不调用模型、不读取用户会话。
const root = await mkdtemp(path.join(tmpdir(), "openscience-timeline-preview-"))
const project = path.join(root, "research")
await mkdir(project)
await Bun.write(
  path.join(project, "README.md"),
  "# Timeline verification fixture\nSynthetic records for local UI verification.\n",
)
const initialized = Bun.spawnSync(["git", "init", project])
if (initialized.exitCode !== 0) throw new Error("Could not initialize preview project")
Object.assign(process.env, {
  OPENSCIENCE_TEST_HOME: path.join(root, "home"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_STATE_HOME: path.join(root, "state"),
  OPENSCIENCE_DISABLE_SHARE: "true",
  OPENSCIENCE_DISABLE_LSP_DOWNLOAD: "true",
  OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENSCIENCE_DISABLE_PROJECT_CONFIG: "true",
  OPENSCIENCE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
  OPENSCIENCE_CONFIG_CONTENT: JSON.stringify({ snapshot: false }),
})
delete process.env.OPENSCIENCE_CONFIG_DIR
const { Instance } = await import("../../backend/cli/src/project/instance")
const { Session } = await import("../../backend/cli/src/session")
const { Identifier } = await import("../../backend/cli/src/id/id")
const { Server } = await import("../../backend/cli/src/server/server")
const result = await Instance.provide({
  directory: project,
  fn: async () => {
    const session = await Session.create({ title: "Action Timeline · verification fixture" })
    for (let index = 0; index < 36; index++) {
      const now = Date.now() - (36 - index) * 5000
      const userID = Identifier.ascending("message")
      await Session.updateMessage({
        id: userID,
        sessionID: session.id,
        role: "user",
        time: { created: now },
        agent: "research",
        effort: "normal",
        model: { providerID: "fixture", modelID: "offline-model" },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: userID,
        type: "text",
        text: [
          "比较处理组与对照组的差异表达，检查统计显著性与结果可重复性。",
          "检索相关研究文献，整理分析方法和实验限制。",
          "检查数据质量，执行 Python 分析并保存研究结果。",
        ][index % 3],
      })
      const messageID = Identifier.ascending("message")
      await Session.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "assistant",
        time: { created: now + 50, completed: now + 4200 },
        parentID: userID,
        agent: "research",
        mode: "research",
        providerID: "fixture",
        modelID: "offline-model",
        path: { cwd: project, root: project },
        cost: 0.002,
        tokens: { input: 120, output: 40, reasoning: 10, cache: { read: 20, write: 0 } },
        finish: "stop",
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID,
        type: "text",
        text: `Synthetic result ${index + 1}; no real model or computation was executed.`,
        time: { start: now + 900, end: now + 4200 },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID,
        type: "tool",
        callID: `fixture-${index}`,
        tool: ["python", "research_search", "skill", "bash", "read", "task"][index % 6],
        state: {
          status: "completed",
          input: { code: "PRIVATE_INPUT_MUST_NOT_APPEAR" },
          title: "Private command omitted from timeline",
          output: "PRIVATE_OUTPUT_MUST_NOT_APPEAR",
          metadata: index % 7 === 0 ? { ok: false } : index % 5 === 0 ? { outcome: "partial" } : {},
          time: { start: now + 1200, end: now + 4000 },
        },
      })
    }
    return { sessionID: session.id, projectID: Instance.project.id }
  },
})
const backendPort = Number(process.env.TIMELINE_BACKEND_PORT ?? 4098)
const frontendPort = Number(process.env.TIMELINE_FRONTEND_PORT ?? 5174)
Server.listen({ port: backendPort, hostname: "127.0.0.1" })
const ui = Bun.spawn(
  [process.execPath, "run", "dev", "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"],
  {
    cwd: path.resolve(import.meta.dir, "../../frontend/workspace"),
    env: {
      ...process.env,
      VITE_OPENSCIENCE_SERVER_HOST: "127.0.0.1",
      VITE_OPENSCIENCE_SERVER_PORT: String(backendPort),
    },
    stdout: "inherit",
    stderr: "inherit",
  },
)
console.log(`Timeline preview: http://127.0.0.1:${frontendPort}/${result.projectID}/session/${result.sessionID}`)
console.log(`Isolated fixture directory: ${root}`)
process.on("SIGINT", () => {
  ui.kill()
  process.exit(0)
})
process.on("SIGTERM", () => {
  ui.kill()
  process.exit(0)
})
await ui.exited
