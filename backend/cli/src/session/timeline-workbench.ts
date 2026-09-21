import z from "zod"
import { Session } from "."
import { SessionStatus } from "./status"
import { SessionTrace } from "./trace"
import { SessionCheckpoint } from "./checkpoint"
import { ActionTimeline } from "./action-timeline"
import { Storage } from "@/storage/storage"
import { KernelRuntime } from "@/science/kernel/registry"
import { Instance } from "@/project/instance"
import { PermissionNext } from "@/permission/next"
import { TimelineBranches } from "./timeline-branches"
import { TimelineRecovery } from "./timeline-recovery"
import { RuntimeRuns } from "@/runtime/runs"
import { ExecutionHistory } from "@/science/execution/history"
import { SessionTelemetry } from "./telemetry"

export namespace TimelineWorkbench {
  export const Checkpoint = z
    .object({
      id: z.string(),
      sessionID: z.string(),
      messageID: z.string().optional(),
      createdAt: z.number(),
      path: z.string(),
      summary: z.string(),
    })
    .meta({ ref: "TimelineCheckpoint" })
  export const Info = z
    .object({
      sessionID: z.string(),
      revert: z
        .object({ messageID: z.string(), turns: z.number().optional(), files: z.string().array().optional() })
        .optional(),
      status: z.enum(["idle", "busy", "retry", "compacting"]),
      checkpoints: Checkpoint.array(),
      branches: z.lazy(() => TimelineBranches.Branch).array(),
      recoveries: z.lazy(() => TimelineRecovery.Run).array(),
      runs: z.object({ id: z.string(), status: z.string(), acceptedAt: z.number() }).array(),
      executions: z
        .object({
          id: z.string(),
          language: z.string(),
          status: z.string(),
          generation: z.number().nullable(),
          queuedAt: z.string().nullable(),
          startedAt: z.string().nullable(),
          completedAt: z.string().nullable(),
          kernelID: z.string().nullable(),
        })
        .array(),
      children: z
        .object({
          sessionID: z.string().optional(),
          agent: z.string(),
          status: z.string(),
          toolCalls: z.number().optional(),
        })
        .array(),
      jobs: z
        .object({ id: z.string(), name: z.string(), target: z.string(), status: z.string(), artifactCount: z.number() })
        .array(),
      kernels: z
        .object({
          id: z.string(),
          language: z.string(),
          state: z.string(),
          incarnation: z.number().nullable(),
          queued: z.number(),
          sandbox: z.string(),
          enforced: z.boolean().nullable(),
          network: z.string(),
        })
        .array(),
      permissions: z.object({ pending: z.number(), total: z.number(), rejected: z.number() }),
      context: z.object({
        input: z.number().nullable(),
        output: z.number().nullable(),
        reasoning: z.number().nullable(),
        cacheRead: z.number().nullable(),
        cacheWrite: z.number().nullable(),
        compactions: z.number(),
      }),
      composition: z
        .object({
          recordedAt: z.number(),
          total: z.number(),
          usable: z.number(),
          system: z.number(),
          text: z.number(),
          reasoning: z.number(),
          tool: z.number(),
          skills: z.number(),
          image: z.number(),
          document: z.number(),
        })
        .optional(),
      capabilities: z.object({
        conversationFork: z.literal(true),
        fileCheckpoint: z.literal(true),
        kernelRestore: z.literal(true),
      }),
    })
    .meta({ ref: "TimelineWorkbench" })
  export type Info = z.infer<typeof Info>

  export async function get(sessionID: string): Promise<Info> {
    await Session.assertDirectory(sessionID)
    const session = await Session.get(sessionID)
    const messages = (await Session.messages({ sessionID })).filter(
      (message) => !session.revert || message.info.id < session.revert.messageID,
    )
    const [trace, keys, pending] = await Promise.all([
      SessionTrace.build(sessionID, { messages }),
      Storage.list(["timeline_checkpoint", sessionID]),
      PermissionNext.list(),
      KernelRuntime.restoreSession(Instance.project.id, sessionID),
    ])
    const checkpoints = await Promise.all(keys.map((key) => Storage.read<z.infer<typeof Checkpoint>>(key)))
    const latest = trace.inference.at(-1)
    const safe = ActionTimeline.text
    const [branches, recoveries, runs, executions] = await Promise.all([
      TimelineBranches.list(sessionID),
      TimelineRecovery.list(sessionID),
      RuntimeRuns.list(sessionID),
      ExecutionHistory.list({ projectID: Instance.project.id, directory: Instance.directory }, sessionID),
    ])
    const field = <T>(value: { status: string; value?: T }) =>
      value.status === "available" ? (value.value ?? null) : null
    const context = SessionTelemetry.context(sessionID)
    return {
      sessionID,
      status: SessionStatus.get(sessionID).type,
      revert: session.revert
        ? {
            messageID: session.revert.messageID,
            turns: session.revert.turns,
            files: session.revert.files?.map((file) => safe(file)),
          }
        : undefined,
      checkpoints: checkpoints.sort((a, b) => b.createdAt - a.createdAt),
      branches,
      recoveries,
      composition: context
        ? { ...context.composition, recordedAt: context.recordedAt, total: context.total, usable: context.usable }
        : undefined,
      runs: runs
        .filter((run) => ["accepted", "running"].includes(run.state))
        .map((run) => ({ id: run.runID, status: run.state, acceptedAt: run.acceptedAt })),
      executions: executions.slice(-200).map((record) => ({
        id: record.id,
        language: record.language,
        status: record.status,
        generation: field(record.environment.incarnation),
        queuedAt: field(record.timing.created_at),
        startedAt: field(record.timing.started_at),
        completedAt: field(record.timing.completed_at),
        kernelID: field(record.environment.kernel_id),
      })),
      children: trace.children.map((child) => ({
        sessionID: child.sessionID,
        agent: safe(child.agent),
        status: child.sessionID && SessionStatus.get(child.sessionID).type !== "idle" ? "running" : child.status,
        toolCalls: child.toolCalls,
      })),
      jobs: trace.jobs.map((job) => ({
        id: job.id,
        name: safe(job.name),
        target: job.target,
        status: job.status,
        artifactCount: job.artifactCount,
      })),
      kernels: KernelRuntime.list(sessionID)
        .filter((kernel) => kernel.projectID === Instance.project.id)
        .map((kernel) => ({
          id: kernel.id,
          language: kernel.language,
          state: kernel.state,
          incarnation: kernel.incarnation,
          queued: kernel.queue_depth,
          sandbox: kernel.environment?.sandbox.backend ?? "unknown",
          enforced: kernel.environment?.sandbox.enforced ?? null,
          network: kernel.environment?.sandbox.network ?? "unknown",
        })),
      permissions: {
        pending: pending.filter((item) => item.sessionID === sessionID).length,
        total: trace.approvals.length,
        rejected: trace.approvals.filter((item) => item.reply === "reject").length,
      },
      // 这些是提供商报告的最近一次用量，不能伪称为精确的系统提示/工具 Schema 分解。
      context: {
        input: latest?.tokens.input ?? null,
        output: latest?.tokens.output ?? null,
        reasoning: latest?.tokens.reasoning ?? null,
        cacheRead: latest?.tokens.cache.read ?? null,
        cacheWrite: latest?.tokens.cache.write ?? null,
        compactions: messages.filter((message) => message.parts.some((part) => part.type === "compaction")).length,
      },
      capabilities: { conversationFork: true, fileCheckpoint: true, kernelRestore: true },
    }
  }

  export async function checkpoint(sessionID: string) {
    await Session.assertDirectory(sessionID)
    await KernelRuntime.restoreSession(Instance.project.id, sessionID)
    if (
      SessionStatus.get(sessionID).type !== "idle" ||
      KernelRuntime.list(sessionID).some((kernel) => kernel.state === "running" || kernel.queue_depth > 0)
    )
      throw new Session.BusyError(sessionID)
    const result = await SessionCheckpoint.create({ sessionID })
    const session = await Session.get(sessionID)
    const latest = (await Session.messages({ sessionID }))
      .filter((message) => !session.revert || message.info.id < session.revert.messageID)
      .at(-1)
    const record: z.infer<typeof Checkpoint> = {
      id: crypto.randomUUID(),
      sessionID,
      messageID: latest?.info.id,
      createdAt: Date.now(),
      path: result.relative,
      summary: ActionTimeline.text(result.summary, 500),
    }
    await TimelineRecovery.capture(sessionID, record.id, record.messageID)
    await Storage.write(["timeline_checkpoint", sessionID, record.id], record)
    return record
  }
}
