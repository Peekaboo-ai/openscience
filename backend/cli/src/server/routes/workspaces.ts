import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import { upgradeWebSocket } from "hono/bun"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { Global } from "../../global"
import { JsonStore } from "../../util/jsonstore"
import { ManagedProject } from "../../project/managed"
import { Project } from "../../project/project"
import { Instance } from "../../project/instance"
import { Session } from "../../session"
import { SessionFilesystem } from "../../session/filesystem"
import { RemoteWorkspaces } from "../../remote/registry"
import { Target, listEnvironment } from "../../remote/transport"
import { LIMIT } from "../../remote/protocol"
import { ComputeSettings } from "./settings/compute"
import { lazy } from "@synsci/util/lazy"
import { ComputeEnvironment } from "../../compute/environment"
import { createDirectory, projectDirectory, resolveDirectory, workspaceDirectory } from "../../remote/directories"

const selection = z.object({
  directory: z.string().trim().max(4096).optional(),
  name: z.string().trim().min(1).max(100),
})
const directoryInfo = z.object({
  directory: z.string(),
  workingDirectory: z.string(),
  parent: z.string(),
  entries: z.array(z.object({ name: z.string(), path: z.string() })),
})
const catalog = z.object({
  projects: Project.Info.array(),
  tasksProjectID: z.string().optional(),
  remotes: RemoteWorkspaces.Status.array(),
})
const schema = (operationId: string, value: z.ZodType) =>
  describeRoute({
    operationId,
    responses: { 200: { description: "Success", content: { "application/json": { schema: resolver(value) } } } },
  })
const file = () => path.join(Global.Path.data, "workspace-catalog.json")
const remoteID = z.object({ id: z.string().uuid() })
function remoteClient(id: string) {
  try {
    return RemoteWorkspaces.client(id)
  } catch (error) {
    throw new HTTPException(503, { message: error instanceof Error ? error.message : "Remote workspace disconnected" })
  }
}
const meta = async () =>
  z
    .object({ tasksProjectID: z.string().optional() })
    .passthrough()
    .parse(await JsonStore.read(file(), { strict: true }))

export async function openWorkspace(input: z.infer<typeof selection>) {
  const directory = await projectDirectory(input)
  const digest = crypto.createHash("sha256").update(`workspace-folder:${directory}`).digest("hex")
  const operationID = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  const result = await ManagedProject.createIdempotent({
    operationID,
    fingerprint: digest,
    name: input.name,
    checkpoint: (project) =>
      Instance.provide({
        directory: project.worktree,
        projectID: project.id,
        fn: () =>
          SessionFilesystem.seedProject({ projectID: project.id, grants: [{ path: directory, access: "write" }] }),
      }).then(() => undefined),
  })
  if (result.status === "conflict") throw new Error("This folder is already bound to another workspace")
  return { project: result.project, directory }
}

export const WorkspaceRoutes = lazy(() =>
  new Hono()
    .get("/environment", schema("workspace.environment", ComputeEnvironment.Info), async (c) =>
      c.json(await ComputeEnvironment.inspect()),
    )
    .get("/catalog", schema("workspace.catalog", catalog), async (c) =>
      c.json({
        projects: await ManagedProject.list(),
        tasksProjectID: (await meta()).tasksProjectID,
        remotes: await RemoteWorkspaces.list(),
      }),
    )
    .post("/task", schema("workspace.task", Session.Info), async (c) => {
      let projectID = ""
      await JsonStore.update(file(), async (draft) => {
        if (typeof draft.tasksProjectID === "string") {
          await Project.resolve(draft.tasksProjectID)
          projectID = draft.tasksProjectID
          return
        }
        const result = await ManagedProject.createIdempotent({
          operationID: "a1053f5c-0765-41e6-b14a-659356b2d808",
          fingerprint: crypto.createHash("sha256").update("standalone-tasks-v1").digest("hex"),
          name: "Tasks",
        })
        if (result.status === "conflict") throw new Error("Task workspace conflict")
        projectID = result.project.id
        draft.tasksProjectID = projectID
      })
      const selected = await Project.resolve(projectID)
      return c.json(await Instance.provide({ projectID, directory: selected.directory, fn: () => Session.create({}) }))
    })
    .get(
      "/directories",
      schema("workspace.directories", directoryInfo),
      validator("query", z.object({ path: z.string().max(4096).optional() })),
      async (c) => {
        const directory = await resolveDirectory(c.req.valid("query").path ?? workspaceDirectory)
        const entries = (await fs.readdir(directory, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 2000)
          .map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) }))
        return c.json({ directory, workingDirectory: workspaceDirectory, parent: path.dirname(directory), entries })
      },
    )
    .post(
      "/directories",
      schema("workspace.createDirectory", z.object({ directory: z.string() })),
      validator(
        "json",
        z.object({ parent: z.string().trim().min(1).max(4096), name: z.string().trim().min(1).max(100) }).strict(),
      ),
      async (c) => {
        const input = c.req.valid("json")
        try {
          return c.json({ directory: await createDirectory(input.parent, input.name) })
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          throw new HTTPException(400, {
            message:
              code === "EEXIST"
                ? "A file or folder with this name already exists."
                : code === "EACCES" || code === "EPERM"
                  ? "You do not have permission to create a folder here."
                  : error instanceof Error
                    ? error.message
                    : "Could not create folder.",
          })
        }
      },
    )
    .post(
      "/open",
      schema("workspace.open", z.object({ project: Project.Info, directory: z.string() })),
      validator("json", selection),
      async (c) => c.json(await openWorkspace(c.req.valid("json"))),
    ),
)

export const RemoteWorkspaceRoutes = lazy(() =>
  new Hono()
    .use(async (c, next) => {
      if (process.env.OPENSCIENCE_REMOTE_WORKER === "1")
        return c.json({ message: "Nested remote connections are unavailable" }, 403)
      await next()
    })
    .get("/", schema("remoteWorkspace.list", RemoteWorkspaces.Status.array()), async (c) =>
      c.json(await RemoteWorkspaces.list()),
    )
    .get(
      "/options",
      schema(
        "remoteWorkspace.options",
        z.object({
          hosts: z.array(z.object({ id: z.string(), label: z.string(), ready: z.boolean() })),
          configs: ComputeSettings.SshConfigHost.array(),
          wsl: z.string().array(),
          docker: z.string().array(),
        }),
      ),
      async (c) => {
        const [settings, wsl, docker] = await Promise.all([
          ComputeSettings.get(),
          process.platform === "win32" ? listEnvironment("wsl.exe", ["--list", "--quiet"]).catch(() => []) : [],
          listEnvironment("docker", ["ps", "--format", "{{.Names}}"]).catch(() => []),
        ])
        return c.json({
          hosts: settings.ssh_hosts.map((host) => ({
            id: host.id,
            label: host.label,
            ready: !!host.host_key && !!host.fingerprint,
          })),
          configs: settings.ssh_config_hosts,
          wsl,
          docker,
        })
      },
    )
    .post(
      "/",
      schema("remoteWorkspace.create", RemoteWorkspaces.Status),
      validator("json", z.object({ name: RemoteWorkspaces.Bookmark.shape.name, target: Target }).strict()),
      async (c) => c.json(await RemoteWorkspaces.create(c.req.valid("json"))),
    )
    .post(
      "/:id/connect",
      schema("remoteWorkspace.connect", RemoteWorkspaces.Status),
      validator("param", remoteID),
      async (c) => c.json(await RemoteWorkspaces.connect(c.req.param("id"))),
    )
    .post(
      "/:id/disconnect",
      schema("remoteWorkspace.disconnect", z.boolean()),
      validator("param", remoteID),
      async (c) => {
        RemoteWorkspaces.disconnect(c.req.param("id"))
        return c.json(true)
      },
    )
    .delete("/:id", schema("remoteWorkspace.remove", z.boolean()), validator("param", remoteID), async (c) => {
      await RemoteWorkspaces.remove(c.req.param("id"))
      return c.json(true)
    })
    .post(
      "/:id/open",
      schema("remoteWorkspace.open", RemoteWorkspaces.Status),
      validator("param", remoteID),
      validator("json", selection),
      async (c) => {
        const id = c.req.param("id")
        const client = remoteClient(id)
        const response = await client.request("/workspace/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(c.req.valid("json")),
          signal: c.req.raw.signal,
        })
        if (!response.ok) {
          const detail = await response.json().catch(() => undefined)
          return c.json(
            {
              message:
                detail?.message ??
                detail?.data?.message ??
                "Could not open this remote directory. Check its path and permissions.",
            },
            400,
          )
        }
        const value = z.object({ project: Project.Info, directory: z.string() }).parse(await response.json())
        return c.json(await RemoteWorkspaces.bind(id, value.directory, value.project.id, c.req.valid("json").name))
      },
    )
    .use(
      "/:id/api/*",
      bodyLimit({
        maxSize: LIMIT / 2,
        onError: (c) =>
          c.json(
            { message: "Remote request is larger than 16 MiB. Use a file transfer tool for larger uploads." },
            413,
          ),
      }),
    )
    .all("/:id/api/*", async (c, next) => {
      const id = c.req.param("id")
      const client = remoteClient(id)
      const url = new URL(c.req.url)
      const route = url.pathname.slice(url.pathname.indexOf("/api/") + 4) + url.search
      if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
        return upgradeWebSocket(() => {
          let socket: ReturnType<typeof client.socket> | undefined
          return {
            onOpen(_event, ws) {
              socket = client.socket(route, (frame) => {
                if (frame.type === "message")
                  ws.send(frame.binary ? Buffer.from(frame.data ?? "", "base64") : (frame.data ?? ""))
                if (frame.type === "close" || frame.type === "error") ws.close(1011, "Remote terminal disconnected")
              })
            },
            onMessage(event) {
              socket?.send(typeof event.data === "string" ? event.data : (event.data as ArrayBuffer))
            },
            onClose() {
              socket?.close()
            },
            onError() {
              socket?.close()
            },
          }
        })(c, next)
      }
      const body = ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.arrayBuffer()
      return client.request(route, { method: c.req.method, headers: c.req.raw.headers, body, signal: c.req.raw.signal })
    }),
)
