import z from "zod"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { SessionStatus } from "./status"
import { observableToolStatus } from "./tool-outcome"
import { Storage } from "@/storage/storage"
import { Identifier } from "@/id/id"
import { OpenScience } from "@/openscience"
import { ExecutionHistory } from "@/science/execution/history"
import { Instance } from "@/project/instance"

/** 将持久化消息投影为公开行动记录；原始参数、输出和推理内容不跨越此边界。 */
export namespace ActionTimeline {
  const Time = z.number().finite().nonnegative()
  export const Entry = z
    .object({
      id: z.string(),
      messageID: z.string(),
      turnID: z.string(),
      kind: z.enum(["user", "inference", "tool", "kernel", "delegation", "retry", "compaction", "checkpoint"]),
      title: z.string(),
      status: z.enum(["pending", "running", "completed", "partial", "error", "cancelled", "interrupted"]),
      owner: z.string(),
      tool: z.string().optional(),
      model: z.string().optional(),
      provider: z.string().optional(),
      language: z.enum(["python", "r"]).optional(),
      startedAt: Time.optional(),
      queuedAt: Time.optional(),
      generation: z.number().optional(),
      executionID: z.string().optional(),
      responseAt: Time.optional(),
      completedAt: Time.optional(),
      tokens: z
        .object({
          input: z.number(),
          output: z.number(),
          reasoning: z.number(),
          cacheRead: z.number(),
          cacheWrite: z.number(),
        })
        .optional(),
      cost: z.number().nonnegative().optional(),
      resources: z.array(z.string()),
      artifacts: z.array(z.string()),
      childSessionID: z.string().optional(),
      error: z.string().optional(),
    })
    .meta({ ref: "ActionTimelineEntry" })
  export type Entry = z.infer<typeof Entry>

  export const Query = z
    .object({
      before: Identifier.schema("message").optional(),
      after: Identifier.schema("message").optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    })
    .refine((value) => !(value.before && value.after), "before and after are mutually exclusive")

  export const Page = z
    .object({
      sessionID: z.string(),
      status: z.enum(["idle", "retry", "busy", "compacting"]),
      entries: Entry.array(),
      messageIDs: z.string().array(),
      totalMessages: z.number(),
      first: z.string().nullable(),
      last: z.string().nullable(),
      hasEarlier: z.boolean(),
      hasMore: z.boolean(),
      generatedAt: Time,
    })
    .meta({ ref: "ActionTimelinePage" })
  export type Page = z.infer<typeof Page>

  export function text(value: unknown, limit = 160) {
    return typeof value === "string"
      ? OpenScience.redactSecrets(value)
          .replace(/https?:\/\/\S+/gi, "[url]")
          .replace(/[\x00-\x1f\x7f]/g, " ")
          .slice(0, limit)
      : ""
  }

  const time = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
  const identifier = (value: unknown) =>
    typeof value === "string" && /^[\w.:-]{1,180}$/.test(value) ? value : undefined
  const amount = (value: number) => (Number.isFinite(value) && value >= 0 ? value : 0)

  function tool(part: MessageV2.ToolPart, base: Entry, active: boolean): Entry {
    const state = part.state
    const meta: Record<string, unknown> = state.status === "pending" ? {} : (state.metadata ?? {})
    const status = observableToolStatus(part)
    const language = ["python", "notebook"].includes(part.tool)
      ? "python"
      : ["r", "rkernel"].includes(part.tool)
        ? "r"
        : undefined
    const start = state.status === "pending" ? undefined : time(state.time.start)
    const end = state.status === "completed" || state.status === "error" ? time(state.time.end) : undefined
    return {
      ...base,
      id: part.id,
      kind: language ? "kernel" : part.tool === "task" ? "delegation" : "tool",
      // 工具标题可能含完整命令或私有数据；公开视图仅使用工具标识。
      title: text(part.tool),
      tool: text(part.tool),
      language,
      status:
        meta.cancelled === true
          ? "cancelled"
          : !active && (status === "running" || status === "pending")
            ? "interrupted"
            : status,
      startedAt: start,
      responseAt: undefined,
      completedAt: end !== undefined && start !== undefined && end >= start ? end : undefined,
      tokens: undefined,
      cost: undefined,
      childSessionID: identifier(meta.sessionId),
      resources: [identifier(meta.provenanceID)].filter((item): item is string => !!item),
      artifacts: [identifier(meta.artifactID), identifier(meta.versionID)].filter((item): item is string => !!item),
      error: status === "error" ? "Execution failed. Inspect the original conversation for details." : undefined,
    }
  }

  export function project(message: MessageV2.WithParts, active: boolean): Entry[] {
    const info = message.info
    const assistant = info.role === "assistant" ? info : undefined
    const start = time(info.time.created)
    const finish = time(assistant?.time.completed)
    const response = message.parts
      .flatMap((part) =>
        (part.type === "text" || part.type === "reasoning") && part.time?.start !== undefined ? [part.time.start] : [],
      )
      .filter((value) => Number.isFinite(value) && value >= (start ?? 0) && (finish === undefined || value <= finish))
      .sort((a, b) => a - b)[0]
    const base: Entry = {
      id: info.id,
      messageID: info.id,
      turnID: assistant?.parentID ?? info.id,
      kind: assistant ? "inference" : "user",
      // 仅展示用户主动提交的正文摘要；合成提示、工具输入输出和推理内容不进入请求标题。
      title: assistant
        ? "Model response"
        : text(
            message.parts
              .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
              .map((part) => part.text)
              .join(" "),
          )
            .replace(/\s+/g, " ")
            .trim() || "User request",
      owner: assistant ? text(assistant.agent) : "user",
      status: assistant?.error
        ? assistant.error.name === "MessageAbortedError"
          ? "cancelled"
          : "error"
        : !assistant || finish !== undefined
          ? "completed"
          : active
            ? "running"
            : "interrupted",
      startedAt: start,
      responseAt: response,
      completedAt: assistant ? (finish !== undefined && finish >= (start ?? 0) ? finish : undefined) : start,
      resources: [],
      artifacts: [],
      ...(assistant
        ? {
            model: text(assistant.modelID),
            provider: text(assistant.providerID),
            tokens: {
              input: amount(assistant.tokens.input),
              output: amount(assistant.tokens.output),
              reasoning: amount(assistant.tokens.reasoning),
              cacheRead: amount(assistant.tokens.cache.read),
              cacheWrite: amount(assistant.tokens.cache.write),
            },
            cost: amount(assistant.cost),
          }
        : {}),
    }
    const entries: Entry[] = [base]
    for (const part of message.parts) {
      if (part.type === "tool") entries.push(tool(part, base, active))
      if (part.type === "retry")
        entries.push({
          ...base,
          id: part.id,
          kind: "retry",
          title: `Retry ${part.attempt}`,
          status: "completed",
          startedAt: time(part.time.created),
          completedAt: time(part.time.created),
          responseAt: undefined,
          tokens: undefined,
          cost: undefined,
        })
      if (part.type === "compaction")
        entries.push({
          ...base,
          id: part.id,
          kind: "compaction",
          title: "Context compaction",
          tokens: undefined,
          cost: undefined,
        })
      if (part.type === "step-start" && part.snapshot)
        entries.push({
          ...base,
          id: part.id,
          kind: "checkpoint",
          title: "File snapshot",
          status: "completed",
          resources: [text(part.snapshot)],
          completedAt: start,
          responseAt: undefined,
          tokens: undefined,
          cost: undefined,
        })
    }
    return entries
  }

  export async function get(sessionID: string, input: z.input<typeof Query> = {}): Promise<Page> {
    await Session.assertDirectory(sessionID)
    const query = Query.parse(input)
    const session = await Session.get(sessionID)
    // 游标使用持久化消息 ID，新增行动和工具状态更新不会移动历史页边界。
    const all = (await Storage.list(["message", sessionID]))
      .map((key) => key[2])
      .filter((id) => !session.revert || id < session.revert.messageID)
    const eligible = all.filter((id) => (!query.before || id < query.before) && (!query.after || id > query.after))
    const selected = query.after ? eligible.slice(0, query.limit) : eligible.slice(-query.limit)
    const messages = await Promise.all(selected.map((messageID) => MessageV2.get({ sessionID, messageID })))
    const status = SessionStatus.get(sessionID).type
    const entries = messages.flatMap((message) => project(message, status !== "idle"))
    const history = await ExecutionHistory.list(
      { projectID: Instance.project.id, directory: Instance.directory },
      sessionID,
    )
    const executions = new Map(
      history.filter((record) => record.call_id).map((record) => [`${record.message_id}:${record.call_id}`, record]),
    )
    const parts = new Map(
      messages.flatMap((message) =>
        message.parts.filter((part) => part.type === "tool").map((part) => [part.id, part] as const),
      ),
    )
    for (const entry of entries) {
      const part = parts.get(entry.id)
      const execution = part && executions.get(`${entry.messageID}:${part.callID}`)
      if (!execution) continue
      const stamp = (field: { status: string; value?: string }) =>
        field.status === "available" ? time(Date.parse(field.value!)) : undefined
      entry.queuedAt = stamp(execution.timing.created_at)
      entry.startedAt = stamp(execution.timing.started_at) ?? entry.startedAt
      entry.completedAt = stamp(execution.timing.completed_at) ?? entry.completedAt
      entry.generation =
        execution.environment.incarnation.status === "available" ? execution.environment.incarnation.value : undefined
      entry.executionID = execution.id
      entry.resources = [...new Set([...entry.resources, execution.id])]
    }
    const first = selected[0] ?? null
    const last = selected.at(-1) ?? null
    return {
      sessionID,
      status,
      entries,
      messageIDs: selected,
      totalMessages: all.length,
      first,
      last,
      hasEarlier: first !== null && all.some((id) => id < first),
      hasMore: last !== null && all.some((id) => id > last),
      generatedAt: Date.now(),
    }
  }
}
