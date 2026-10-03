import path from "node:path"
import { createHash } from "node:crypto"
import type { LanguageModelUsage } from "ai"
import z from "zod"
import { Global } from "@/global"
import { Storage } from "@/storage/storage"
import { work } from "@/util/queue"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { UsageRecord, UsageTokens, type UsageQuery } from "./usage-stats-schema"
import { buildUsageReport } from "./usage-stats-report"

const log = Log.create({ service: "usage-stats" })
const SessionInfo = z.object({
  id: z.string(),
  projectID: z.string(),
  title: z.string(),
  parentID: z.string().optional(),
  time: z.object({ created: z.number() }),
})
const ProjectInfo = z.object({ id: z.string(), name: z.string().optional(), worktree: z.string() })
const Tokens = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number().default(0),
  cache: z.object({ read: z.number(), write: z.number() }),
})
const AssistantInfo = z.object({
  id: z.string(),
  sessionID: z.string(),
  role: z.literal("assistant"),
  providerID: z.string(),
  modelID: z.string(),
  time: z.object({ created: z.number(), completed: z.number().optional() }),
  tokens: Tokens,
})
const Finish = z.object({ id: z.string(), type: z.literal("step-finish"), tokens: Tokens })
const finite = (value: number) => (Number.isFinite(value) && value >= 0 ? value : 0)
const convert = (value: z.infer<typeof Tokens>): UsageTokens => ({
  input: finite(value.input),
  output: finite(value.output),
  reasoning: finite(value.reasoning),
  cacheRead: finite(value.cache.read),
  cacheWrite: finite(value.cache.write),
})
const legacyID = (value: string) => `history_${createHash("sha256").update(value).digest("hex")}`
const messageKey = (row: Pick<UsageRecord, "sessionID" | "messageID">) => `${row.sessionID}:${row.messageID}`

type Collection = { records: UsageRecord[]; skipped: number; inherited: number; available: Set<string> }
let cache: { root: string; at: number; data: Collection } | undefined
let pending: { root: string; promise: Promise<Collection> } | undefined

async function read<T>(key: string[], schema: z.ZodType<T>, failures: { count: number }) {
  const raw = await Storage.read<unknown>(key).catch((error) => {
    if (Storage.NotFoundError.isInstance(error)) return undefined
    failures.count++
    log.warn("unreadable usage source", { kind: key[0] })
    return undefined
  })
  if (raw === undefined) return
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  failures.count++
  return undefined
}

async function collect(): Promise<Collection> {
  const failures = { count: 0 }
  const projects = new Map<string, string>()
  await work(8, await Storage.list(["project"]), async (key) => {
    const project = await read(key, ProjectInfo, failures)
    if (project) projects.set(project.id, project.name || path.basename(project.worktree) || project.id)
  })
  const sessions = new Map<string, z.infer<typeof SessionInfo>>()
  await work(8, await Storage.list(["session"]), async (key) => {
    const session = await read(key, SessionInfo, failures)
    if (session) sessions.set(session.id, session)
  })
  const records = new Map<string, UsageRecord>()
  await work(8, await Storage.list(["usage"]), async (key) => {
    const record = await read(key, UsageRecord, failures)
    if (record) records.set(record.id, record)
  })
  const responses = new Set(
    [...records.values()].filter((record) => record.source === "response" && record.kind === "session").map(messageKey),
  )
  const completed = new Set(
    [...records.values()].filter((record) => record.source === "history" && record.historyComplete).map(messageKey),
  )
  const inherited = { count: 0 }
  await work(8, await Storage.list(["message"]), async (key) => {
    const session = sessions.get(key[1])
    if (!session || responses.has(`${key[1]}:${key[2]}`) || completed.has(`${key[1]}:${key[2]}`)) return
    const raw = await Storage.read<Record<string, unknown>>(key).catch((error) => {
      if (!Storage.NotFoundError.isInstance(error)) failures.count++
      return undefined
    })
    if (!raw || raw.role !== "assistant") return
    const parsed = AssistantInfo.safeParse(raw)
    if (!parsed.success) {
      failures.count++
      return
    }
    const message = parsed.data
    if (message.time.created < session.time.created) {
      inherited.count++
      return
    }
    const parts: z.infer<typeof Finish>[] = []
    for (const partKey of await Storage.list(["part", message.id])) {
      const raw = await Storage.read<Record<string, unknown>>(partKey).catch((error) => {
        if (!Storage.NotFoundError.isInstance(error)) failures.count++
        return undefined
      })
      if (!raw || raw.type !== "step-finish") continue
      const parsed = Finish.safeParse(raw)
      if (!parsed.success) {
        failures.count++
        continue
      }
      parts.push(parsed.data)
    }
    const candidates = parts.length
      ? parts
      : message.tokens.input + message.tokens.output + message.tokens.cache.read + message.tokens.cache.write > 0
        ? [{ ...message, type: "step-finish" as const }]
        : []
    for (const part of candidates) {
      const id = legacyID(part.id)
      if (records.has(id) && (!message.time.completed || records.get(id)?.historyComplete)) continue
      const timestamp = /^prt_[0-9a-f]{12}/i.test(part.id) ? Identifier.timestamp(part.id) : 0
      const record: UsageRecord = {
        id,
        projectID: session.projectID,
        projectName: projects.get(session.projectID) ?? session.projectID,
        sessionID: session.id,
        sessionTitle: session.title,
        parentID: session.parentID,
        messageID: message.id,
        providerID: message.providerID,
        modelID: message.modelID,
        route: "unknown",
        kind: "session",
        source: "history",
        historyComplete: !!message.time.completed,
        occurredAt:
          timestamp >= message.time.created && timestamp <= Date.now()
            ? timestamp
            : (message.time.completed ?? message.time.created),
        tokens: convert(part.tokens),
        reported: false,
      }
      await Storage.write(["usage", id], record).catch(() => {
        failures.count++
        log.warn("could not retain historical usage")
      })
      records.set(id, record)
    }
  })
  return {
    records: [...records.values()]
      .filter((record) => record.source === "response" || !responses.has(messageKey(record)))
      .map((record) => ({
        ...record,
        projectName: projects.get(record.projectID) ?? record.projectName,
        sessionTitle: sessions.get(record.sessionID)?.title ?? record.sessionTitle,
      })),
    skipped: failures.count,
    inherited: inherited.count,
    available: new Set(sessions.keys()),
  }
}

export namespace UsageStats {
  export async function record(input: {
    id: string
    projectID: string
    projectName: string
    sessionID: string
    messageID: string
    providerID: string
    modelID: string
    route: string
    kind: UsageRecord["kind"]
    usage: LanguageModelUsage
    tokens: z.infer<typeof Tokens>
  }) {
    const session = await Storage.read<unknown>(["session", input.projectID, input.sessionID])
      .then((raw) => SessionInfo.safeParse(raw).data)
      .catch((error) => {
        if (!Storage.NotFoundError.isInstance(error)) log.warn("could not read usage session label")
        return undefined
      })
    const reported = [input.usage.inputTokens, input.usage.outputTokens].every(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
    )
    const record = UsageRecord.parse({
      id: input.id,
      projectID: input.projectID,
      projectName: input.projectName,
      sessionID: input.sessionID,
      sessionTitle: session?.title ?? input.sessionID,
      parentID: session?.parentID,
      messageID: input.messageID,
      providerID: input.providerID,
      modelID: input.modelID,
      route: input.route,
      kind: input.kind,
      source: "response",
      occurredAt: Date.now(),
      tokens: convert(input.tokens),
      reported,
    })
    await Storage.write(["usage", record.id], record)
    cache = undefined
  }

  export async function report(query: UsageQuery, refresh = false) {
    const root = Global.Path.data
    if (refresh) cache = undefined
    const data =
      cache?.root === root && Date.now() - cache.at < 15_000
        ? cache.data
        : await (() => {
            if (pending?.root === root) return pending.promise
            const promise = collect()
              .then((data) => {
                cache = { root, at: Date.now(), data }
                return data
              })
              .finally(() => {
                if (pending?.promise === promise) pending = undefined
              })
            pending = { root, promise }
            return promise
          })()
    return buildUsageReport(data.records, query, data)
  }
}
