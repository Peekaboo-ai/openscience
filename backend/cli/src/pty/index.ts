import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { type IPty } from "bun-pty"
import z from "zod"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import type { WSContext } from "hono/ws"
import { Instance } from "../project/instance"
import { lazy } from "@synsci/util/lazy"
import { Shell } from "@/shell/shell"
import { ExecutionAuthority } from "@/project/execution"
import { AuthoritySignal } from "@/project/authority-signal"
import { AuthorityProcessLedger } from "@/project/authority-process"
import { Sandbox } from "@/sandbox/sandbox"
import { OpenScience } from "@/openscience"
import { terminalCommand, terminalEnv, terminalSpawnEnv } from "./environment"
import { Replay } from "./replay"
import { WindowsJobLauncher } from "@/process/windows-job-launcher"
import { Filesystem } from "@/util/filesystem"
import { UpdateQuiescence } from "@/process/update-quiescence"
import { relayTerminalResize } from "./resize"
import { createClusterQueries } from "./cluster-queries"
import { terminalInitialization } from "./initialization"
import { encodePtyReplay } from "@synsci/util/pty-replay"

export namespace Pty {
  const log = Log.create({ service: "pty" })
  const REPLAY_REQUEST = "\0"

  function closeSubscriber(ws: WSContext) {
    try {
      ws.close()
    } catch (error) {
      log.warn("terminal subscriber already closed", { error })
    }
  }

  const pty = lazy(async () => {
    const { spawn } = await import("bun-pty")
    return spawn
  })

  export const Info = z
    .object({
      id: Identifier.schema("pty"),
      title: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      projectID: z.string(),
      sessionID: z.string(),
      authority: ExecutionAuthority.Decision,
      status: z.enum(["running", "exited"]),
      pid: z.number(),
    })
    .meta({ ref: "Pty" })

  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    sessionID: z.string().startsWith("ses_"),
    title: z.string().optional(),
  })

  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z.object({
    title: z.string().optional(),
    size: z
      .object({
        rows: z.number().int().min(1).max(1000),
        cols: z.number().int().min(1).max(1000),
      })
      .optional(),
  })

  export type UpdateInput = z.infer<typeof UpdateInput>

  export const Event = {
    Created: BusEvent.define("pty.created", z.object({ info: Info })),
    Updated: BusEvent.define("pty.updated", z.object({ info: Info })),
    Exited: BusEvent.define("pty.exited", z.object({ id: Identifier.schema("pty"), exitCode: z.number() })),
    Deleted: BusEvent.define("pty.deleted", z.object({ id: Identifier.schema("pty") })),
  }

  interface ActiveSession {
    info: Info
    process: IPty
    buffer: Replay.Ring
    subscribers: Map<WSContext, boolean>
    releaseUpdate: () => void
    releaseQueries: () => void
    ready: Promise<void>
  }

  const state = Instance.state(
    () => new Map<string, ActiveSession>(),
    async (sessions) => {
      const projects = new Set<string>()
      for (const session of sessions.values()) {
        projects.add(session.info.projectID)
      }
      // Revoke durable ownership while each exact leader is still available
      // for identity/group verification. Native PTY cleanup follows only as a
      // local handle fallback during failed registration; registered sessions
      // are already gone when revoke resolves.
      await Promise.all([...projects].map((projectID) => AuthorityProcessLedger.revoke({ kind: "pty", projectID })))
      for (const session of sessions.values()) {
        session.releaseQueries()
        session.releaseUpdate()
        for (const ws of session.subscribers.keys()) {
          closeSubscriber(ws)
        }
      }
      sessions.clear()
    },
  )

  export function list() {
    return Array.from(state().values()).map((s) => s.info)
  }

  export function get(id: string) {
    return state().get(id)?.info
  }

  export async function create(input: CreateInput) {
    const id = Identifier.create("pty", false)
    const command = Shell.preferred()
    const spawn = await pty()
    return AuthoritySignal.exclusive(async () => {
      const releaseUpdate = UpdateQuiescence.enter("pty")
      let handedOff = false
      let queries: Awaited<ReturnType<typeof createClusterQueries>>
      let initialization: Awaited<ReturnType<typeof terminalInitialization>> | undefined
      try {
        const authority = await ExecutionAuthority.require({
          projectID: Instance.project.id,
          sessionID: input.sessionID,
          capability: "terminal",
        })
        const project = authority.directory ?? Instance.directory
        // Local projects grant their real worktree as a writable root, so an
        // interactive terminal should open where the user expects. Hosted or
        // otherwise isolated sessions retain their private session workspace.
        const cwd =
          authority.workspace !== authority.scratch
            ? authority.workspace
            : authority.writable.some((root) => Filesystem.contains(root, project))
              ? project
              : authority.workspace
        // Interactive PTY output is not a redaction boundary. Keep provider/cloud
        // credentials on the host; terminals receive runtime discovery only.
        const source = OpenScience.kernelEnv(process.env)
        const env = terminalEnv(source, Instance.project.id, input.sessionID, command)
        initialization = await terminalInitialization(command, env)
        const args = initialization.args
        if (authority.sandbox.enabled) queries = await createClusterQueries()
        if (queries) env.PATH = `${queries.root}:${env.PATH ?? "/usr/bin:/bin"}`
        const sandbox = Sandbox.wrapArgv({
          file: command,
          args,
          workspace: authority.writable,
          readable: [...authority.readable, ...initialization.readable, ...(queries?.readable ?? [])],
          readOnly: [...initialization.readable, ...(queries?.readable ?? [])],
          unreadable: OpenScience.kernelSensitivePaths(),
          options: authority.sandbox,
          terminal: { env },
        })
        const launch = WindowsJobLauncher.wrap(terminalCommand(sandbox.file, sandbox.args, env))
        log.info("creating session", { id, cmd: command, args, cwd })

        const ptyProcess = (() => {
          try {
            return spawn(launch.file, launch.args, {
              name: "xterm-256color",
              cols: 80,
              rows: 24,
              cwd,
              env: terminalSpawnEnv(env),
            })
          } catch (error) {
            Sandbox.cleanup(sandbox)
            throw error
          }
        })()

        let session: ActiveSession | undefined
        let earlyExit: number | undefined
        const ready = Promise.withResolvers<void>()
        const earlyBuffer = Replay.create()
        const sessions = state()
        ptyProcess.onData((data) => {
          ready.resolve()
          const active = session
          if (!active) {
            Replay.append(earlyBuffer, data)
            return
          }
          Replay.append(active.buffer, data)
          for (const [ws, ready] of active.subscribers) {
            if (ws.readyState !== 1) {
              active.subscribers.delete(ws)
              continue
            }
            if (!ready) continue
            try {
              ws.send(data)
            } catch (error) {
              active.subscribers.delete(ws)
              log.warn("terminal subscriber disconnected during output", { id, error })
            }
          }
        })
        ptyProcess.onExit(({ exitCode }) => {
          ready.resolve()
          queries?.close()
          initialization?.close()
          Sandbox.cleanup(sandbox)
          if (!session) {
            earlyExit = exitCode
            return
          }
          const active = session
          log.info("session exited", { id, exitCode })
          active.info.status = "exited"
          for (const ws of active.subscribers.keys()) {
            closeSubscriber(ws)
          }
          active.subscribers.clear()
          void Bus.publish(Event.Exited, { id, exitCode }).catch((error) =>
            log.error("terminal exit notification failed", { id, error }),
          )
          void AuthorityProcessLedger.complete(id)
            .then((completed) => {
              if (!completed) throw new Error(`Terminal ${id} still has a live authority process`)
              sessions.delete(id)
              active.releaseUpdate()
            })
            .catch((error) => log.error("failed to complete terminal authority record", { id, error }))
        })

        const registered = await AuthorityProcessLedger.register({
          id,
          kind: "pty",
          pid: ptyProcess.pid,
          projectID: Instance.project.id,
          sessionID: input.sessionID,
          authorityGeneration: authority.generation,
          windowsRelease: launch.release,
        }).catch(async (error) => {
          await AuthorityProcessLedger.revoke({ id, kind: "pty" }).catch(() => undefined)
          try {
            ptyProcess.kill()
          } catch {}
          Sandbox.cleanup(sandbox)
          throw error
        })
        if (!registered || earlyExit !== undefined) {
          await AuthorityProcessLedger.revoke({ id, kind: "pty" })
          try {
            ptyProcess.kill()
          } catch {}
          Sandbox.cleanup(sandbox)
          throw new Error(
            `Terminal process exited before durable authority registration (code ${earlyExit ?? "unknown"})`,
          )
        }

        const info = {
          id,
          title: input.title || `Terminal ${id.slice(-4)}`,
          command,
          args,
          cwd,
          projectID: Instance.project.id,
          sessionID: input.sessionID,
          authority,
          status: "running",
          pid: ptyProcess.pid,
        } as const
        session = {
          info,
          process: ptyProcess,
          buffer: earlyBuffer,
          subscribers: new Map(),
          ready: sandbox.backend === "bubblewrap" ? ready.promise : Promise.resolve(),
          releaseUpdate,
          releaseQueries: () => {
            queries?.close()
            initialization?.close()
          },
        }
        sessions.set(id, session)
        handedOff = true
        void Bus.publish(Event.Created, { info }).catch((error) =>
          log.error("terminal creation notification failed", { id, error }),
        )
        return info
      } finally {
        if (!handedOff) {
          queries?.close()
          initialization?.close()
          releaseUpdate()
        }
      }
    })
  }

  export async function update(id: string, input: UpdateInput) {
    const session = state().get(id)
    if (!session) return
    if (input.title) {
      session.info.title = input.title
    }
    if (input.size) {
      await resize(id, input.size.cols, input.size.rows)
    }
    await Bus.publish(Event.Updated, { info: session.info })
    return session.info
  }

  export async function remove(id: string) {
    const session = state().get(id)
    if (!session) return
    log.info("removing session", { id })
    await AuthorityProcessLedger.revoke({ id, kind: "pty" })
    session.releaseQueries()
    session.releaseUpdate()
    for (const ws of session.subscribers.keys()) {
      closeSubscriber(ws)
    }
    state().delete(id)
    await Bus.publish(Event.Deleted, { id })
  }

  export async function releaseSession(sessionID: string) {
    const ids = [...state().values()]
      .filter((session) => session.info.sessionID === sessionID)
      .map((session) => session.info.id)
    await Promise.all(ids.map((id) => remove(id)))
  }

  export async function releaseAll() {
    await Promise.all([...state().keys()].map((id) => remove(id)))
  }

  export async function resize(id: string, cols: number, rows: number) {
    const sessions = state()
    const session = sessions.get(id)
    if (!session || session.info.status !== "running") return
    // bwrap 内的 script 尚未启动时，SIGWINCH 无接收者；先等到桥接器输出，
    // 再确认尺寸并放行浏览器输入。否则前端已是 66 列而 readline 一直使用默认 80 列。
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      session.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Terminal startup timed out before window size synchronization")),
          30_000,
        )
        timer.unref()
      }),
    ]).finally(() => clearTimeout(timer))
    if (sessions.get(id) === session && session.info.status === "running") {
      session.process.resize(cols, rows)
      Replay.resize(session.buffer, { cols, rows })
      relayTerminalResize(session.process.pid)
    }
  }

  export function write(id: string, data: string) {
    const session = state().get(id)
    if (session && session.info.status === "running") {
      session.process.write(data)
    }
  }

  export function connect(id: string, ws: WSContext, geometry = false) {
    const session = state().get(id)
    if (!session) {
      closeSubscriber(ws)
      return
    }
    log.info("client connected to session", { id })
    session.subscribers.set(ws, false)
    return {
      onMessage: (message: string | ArrayBuffer) => {
        const data = String(message)
        if (session.subscribers.get(ws) !== true) {
          const buffer = session.buffer
          if (ws.readyState !== 1) return
          session.subscribers.set(ws, true)
          if (buffer.length || geometry) {
            try {
              if (geometry) {
                // 文本仍是原始 PTY 字节；二进制控制帧仅用于显式协商的历史几何回放。
                for (const frame of Replay.frames(buffer)) {
                  ws.send(encodePtyReplay({ type: "resize", size: frame.size }))
                  ws.send(frame.data)
                }
                ws.send(encodePtyReplay({ type: "resize", size: buffer.size }))
                ws.send(encodePtyReplay({ type: "ready" }))
              } else for (const chunk of Replay.chunks(buffer)) ws.send(chunk)
            } catch {
              session.subscribers.delete(ws)
              closeSubscriber(ws)
              return
            }
          }
          if (data === REPLAY_REQUEST) return
        }
        try {
          session.process.write(data)
        } catch {
          session.subscribers.delete(ws)
          closeSubscriber(ws)
        }
      },
      onClose: () => {
        log.info("client disconnected from session", { id })
        session.subscribers.delete(ws)
      },
    }
  }
}
