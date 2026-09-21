import path from "node:path"
import z from "zod"
import { Session } from "."
import { Instance } from "@/project/instance"
import { Global } from "@/global"
import { Storage } from "@/storage/storage"
import { FileLease } from "@/util/file-lease"
import { ExecutionHistory } from "@/science/execution/history"
import { KernelRuntime } from "@/science/kernel/registry"
import { KernelEnvironmentMutation } from "@/science/kernel/environment-mutation"
import { TimelineBranches } from "./timeline-branches"
import { literalAssignments, replayPlan, type ReplayStep } from "./timeline-replay"
import { SessionStatus } from "./status"
import { ProcessIdentity } from "@/process/process-identity"

export namespace TimelineRecovery {
  export const Step = z.object({
    id: z.string(),
    language: z.string(),
    kernelID: z.string(),
    environment: z.string(),
    generation: z.number().optional(),
    policy: z.enum(["safe", "manual"]),
    reason: z.string(),
    hash: z.string(),
  })
  export const Plan = z
    .object({ checkpointID: z.string(), steps: Step.array(), safe: z.number(), manual: z.number() })
    .meta({ ref: "TimelineRecoveryPlan" })
  export const Run = z
    .object({
      id: z.string(),
      checkpointID: z.string(),
      targetID: z.string().optional(),
      status: z.enum(["running", "completed", "partial", "failed", "interrupted"]),
      completed: z.number(),
      total: z.number(),
      manual: z.number(),
      createdAt: z.number(),
      updatedAt: z.number(),
      error: z.string().optional(),
    })
    .meta({ ref: "TimelineRecoveryRun" })
  type Saved = { messageID?: string; steps: ReplayStep[] }
  type Journal = z.infer<typeof Run> & { owner: { pid: number; identity: string } }
  const key = (sessionID: string, checkpointID: string) => ["timeline_recipe", sessionID, checkpointID]
  const runs = (sessionID: string) => ["timeline_recovery", sessionID]

  export async function capture(sessionID: string, checkpointID: string, messageID?: string) {
    const records = await ExecutionHistory.list(
      { projectID: Instance.project.id, directory: Instance.directory },
      sessionID,
    )
    const steps = replayPlan(records).map((step) => ({
      ...step,
      kernelName: KernelRuntime.owned(step.kernelID, Instance.project.id, sessionID)?.name,
    }))
    await Storage.write(key(sessionID, checkpointID), { messageID, steps } satisfies Saved)
  }

  export async function plan(sessionID: string, checkpointID: string) {
    await Session.assertDirectory(sessionID)
    const saved = await Storage.read<Saved>(key(sessionID, checkpointID))
    return Plan.parse({
      checkpointID,
      steps: saved.steps,
      safe: saved.steps.filter((step) => step.policy === "safe").length,
      manual: saved.steps.filter((step) => step.policy === "manual").length,
    })
  }

  export async function list(sessionID: string) {
    await Session.assertDirectory(sessionID)
    const keys = await Storage.list(runs(sessionID))
    return Promise.all(
      keys.map(async (key) => {
        const record = await Storage.read<Journal>(key)
        if (record.status === "running" && !(await ProcessIdentity.owns(record.owner.pid, record.owner.identity))) {
          record.status = "interrupted"
          record.error = "Recovery process ended. Retry creates a fresh branch."
          await Storage.write(key, record)
        }
        return Run.parse(record)
      }),
    ).then((items) => items.sort((a, b) => b.createdAt - a.createdAt))
  }

  export async function fork(sessionID: string, checkpointID: string) {
    await Session.assertDirectory(sessionID)
    const saved = await Storage.read<Saved>(key(sessionID, checkpointID))
    const messages = await Session.messages({ sessionID })
    const next = messages.find((message) => !saved.messageID || message.info.id > saved.messageID)?.info.id
    if (saved.messageID && !messages.some((message) => message.info.id === saved.messageID))
      throw new Error("Checkpoint conversation is no longer available")
    return TimelineBranches.fork(sessionID, next, checkpointID)
  }

  export async function start(sessionID: string, checkpointID: string) {
    await Session.assertDirectory(sessionID)
    await using lease = await FileLease.acquire(path.join(Global.Path.data, "timeline-locks", `${sessionID}.lock`))
    if ((await list(sessionID)).some((run) => run.status === "running")) throw new Error("Recovery is already running")
    if (SessionStatus.get(sessionID).type !== "idle") throw new Session.BusyError(sessionID)
    const saved = await Storage.read<Saved>(key(sessionID, checkpointID))
    const identity = await ProcessIdentity.capture(process.pid)
    if (!identity) throw new Error("Cannot establish durable recovery ownership")
    const record: Journal = {
      id: crypto.randomUUID(),
      checkpointID,
      status: "running",
      completed: 0,
      total: saved.steps.filter((step) => step.policy === "safe").length,
      manual: saved.steps.filter((step) => step.policy === "manual").length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      owner: { pid: process.pid, identity },
    }
    await Storage.write([...runs(sessionID), record.id], record)
    // 独立恢复分支避免检查源内核后发生代次竞态；源会话、文件及解释器始终保留。
    const directory = Instance.directory
    void Instance.provide({ directory, fn: () => execute(sessionID, saved, record) }).catch(async () => {
      await Storage.update<Journal>([...runs(sessionID), record.id], (draft) => {
        draft.status = "failed"
        draft.error = "Recovery failed; inspect execution history before retrying."
        draft.updatedAt = Date.now()
      })
    })
    return Run.parse(record)
  }

  async function execute(sessionID: string, saved: Saved, record: Journal) {
    await Promise.all([import("../tool/notebook"), import("../tool/rkernel")])
    const persist = () => {
      record.updatedAt = Date.now()
      return Storage.write([...runs(sessionID), record.id], record)
    }
    const target = await fork(sessionID, record.checkpointID)
    record.targetID = target.id
    SessionStatus.set(target.id, { type: "busy" })
    const generations = new Map<string, { incarnation: number | null; count: number }>()
    try {
      await persist()
      for (const step of saved.steps.filter((step) => step.policy === "safe")) {
        if (
          !literalAssignments(step.code, step.language) ||
          new Bun.CryptoHasher("sha256").update(step.code).digest("hex") !== step.hash
        )
          throw new Error("Checkpoint code digest mismatch")
        const options =
          step.language === "python"
            ? await KernelEnvironmentMutation.pythonRuntime(step.environment)
            : await KernelEnvironmentMutation.rRuntime()
        // 每个源内核单独映射，防止不同环境/Notebook 的同名变量交叉污染。
        await Session.get(target.id)
        const identity = {
          projectID: Instance.project.id,
          sessionID: target.id,
          name: step.kernelName ?? `recovery:${step.kernelID}`,
          language: step.language,
          environmentName: step.environment === step.language ? undefined : step.environment,
        }
        const result = await KernelRuntime.execute(
          identity,
          step.code,
          {
            timeout: 60000,
            origin: { source: `checkpoint:${record.checkpointID}` },
            onStart: () => {
              const current = KernelRuntime.status(identity)
              const expected = generations.get(step.kernelID)
              // 在队列真正执行边界校验代次和序号，拒绝夹入的 REPL 执行或重启，而不是仅在点击时检查。
              if (
                expected
                  ? current.incarnation !== expected.incarnation || current.execution_count !== expected.count
                  : current.execution_count !== 0
              )
                throw new Error("Recovery kernel changed during replay")
              generations.set(step.kernelID, { incarnation: current.incarnation, count: current.execution_count + 1 })
            },
          },
          options,
        )
        if (!result.ok) throw new Error("A replay step failed; subsequent steps were not executed")
        record.completed++
        await persist()
      }
      record.status = record.manual ? "partial" : "completed"
    } catch {
      record.status = "failed"
      record.error =
        "A replay step failed. Inspect the recovery branch's execution history; retry always starts a fresh branch."
    } finally {
      SessionStatus.set(target.id, { type: "idle" })
    }
    await persist()
  }
}
