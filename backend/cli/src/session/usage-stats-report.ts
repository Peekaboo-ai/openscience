import type { UsageQuery, UsageRecord, UsageReport, UsageTokens, UsageTotals } from "./usage-stats-schema"

const DAY = 86_400_000
const date = (day: number) => new Date(day * DAY).toISOString().slice(0, 10)
const ordinal = (value: string) => Math.floor(Date.parse(value) / DAY)
export const modelKey = (record: Pick<UsageRecord, "providerID" | "modelID">) =>
  JSON.stringify([record.providerID, record.modelID])

const emptyTokens = (): UsageTokens => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
const emptyTotals = (): UsageTotals => ({
  tokens: emptyTokens(),
  total: 0,
  requests: 0,
  sessions: 0,
  unreported: 0,
  background: 0,
})
const total = (tokens: UsageTokens) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite

function add(target: UsageTotals, record: UsageRecord) {
  for (const key of Object.keys(target.tokens) as (keyof UsageTokens)[]) target.tokens[key] += record.tokens[key]
  target.total += total(record.tokens)
  target.requests++
  if (!record.reported) target.unreported++
  if (record.kind === "background") target.background++
}

function summarize(records: UsageRecord[]) {
  const result = emptyTotals()
  const sessions = new Set<string>()
  for (const record of records) {
    add(result, record)
    sessions.add(record.sessionID)
  }
  result.sessions = sessions.size
  return result
}

function groups(records: UsageRecord[], kind: "models" | "projects" | "sessions", available: Set<string>) {
  const items = new Map<string, UsageReport["models"][number]>()
  const members = new Map<string, Set<string>>()
  for (const record of records) {
    const id = kind === "models" ? modelKey(record) : kind === "projects" ? record.projectID : record.sessionID
    const item = items.get(id) ?? {
      ...emptyTotals(),
      id,
      label: kind === "models" ? record.modelID : kind === "projects" ? record.projectName : record.sessionTitle,
      secondary: kind === "models" ? record.providerID : kind === "sessions" ? record.projectName : record.projectID,
      ...(kind === "models"
        ? { providerID: record.providerID, modelID: record.modelID }
        : { projectID: record.projectID }),
      lastUsed: 0,
      available: kind !== "sessions" || available.has(record.sessionID),
    }
    add(item, record)
    item.lastUsed = Math.max(item.lastUsed, record.occurredAt)
    const sessions = members.get(id) ?? new Set<string>()
    sessions.add(record.sessionID)
    item.sessions = sessions.size
    members.set(id, sessions)
    items.set(id, item)
  }
  return [...items.values()].sort((a, b) => b.total - a.total || b.lastUsed - a.lastUsed || a.id.localeCompare(b.id))
}

export function buildUsageReport(
  records: UsageRecord[],
  query: UsageQuery,
  context: { now?: number; skipped?: number; inherited?: number; available?: Set<string> } = {},
): UsageReport {
  const now = context.now ?? Date.now()
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: query.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const day = (at: number) => {
    const parts = formatter.formatToParts(at)
    return ordinal(["year", "month", "day"].map((key) => parts.find((part) => part.type === key)!.value).join("-"))
  }
  const today = day(now)
  const dated = records
    .filter((record) => record.occurredAt <= now)
    .map((record) => ({ record, day: day(record.occurredAt) }))
  const filtered = dated.filter(
    ({ record }) =>
      (!query.project || record.projectID === query.project) &&
      (!query.provider || record.providerID === query.provider) &&
      (!query.model || modelKey(record) === query.model),
  )
  const earliest = filtered.reduce((first, item) => Math.min(first, item.day), today)
  const end = query.range === "custom" ? ordinal(query.to!) : today
  const start =
    query.range === "all"
      ? earliest
      : query.range === "custom"
        ? ordinal(query.from!)
        : end - (query.range === "today" ? 0 : Number.parseInt(query.range, 10) - 1)
  const selected = filtered.filter((item) => item.day >= start && item.day <= end)
  const rows = selected.map((item) => item.record)
  const length = end - start + 1
  const previous =
    query.range === "all"
      ? null
      : summarize(filtered.filter((item) => item.day >= start - length && item.day < start).map((item) => item.record))
  const days = new Map<number, UsageTotals>()
  for (const item of selected) {
    const value = days.get(item.day) ?? emptyTotals()
    add(value, item.record)
    days.set(item.day, value)
  }
  const peak = [...days.entries()].sort((a, b) => b[1].total - a[1].total)[0]
  const interval = length <= 90 ? "day" : length <= 366 ? "week" : "month"
  const buckets = new Map<number, { end: number; value: UsageTotals }>()
  const bucket = (value: number) =>
    interval === "day"
      ? value
      : interval === "week"
        ? start + Math.floor((value - start) / 7) * 7
        : ordinal(`${date(value).slice(0, 7)}-01`)
  const next = (value: number) =>
    interval === "day"
      ? value + 1
      : interval === "week"
        ? value + 7
        : (() => {
            const current = new Date(value * DAY)
            return Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1) / DAY
          })()
  for (let cursor = bucket(start); cursor <= end; cursor = next(cursor)) {
    buckets.set(cursor, { end: Math.min(end, next(cursor) - 1), value: emptyTotals() })
  }
  for (const item of selected) add(buckets.get(bucket(item.day))!.value, item.record)
  const activityStart = Math.max(start, end - 363)
  const max = [...days.values()].reduce((value, current) => Math.max(value, current.total), 0)
  const activity = Array.from({ length: end - activityStart + 1 }, (_, index) => {
    const value = days.get(activityStart + index)
    const tokens = value?.total ?? 0
    return {
      date: date(activityStart + index),
      total: tokens,
      requests: value?.requests ?? 0,
      level: tokens > 0 && max > 0 ? Math.min(4, Math.max(1, Math.ceil((tokens / max) * 4))) : 0,
    }
  })
  const projects = new Map<string, string>()
  const providers = new Set<string>()
  const models = new Map<string, { id: string; label: string; providerID: string }>()
  for (const record of records) {
    projects.set(record.projectID, record.projectName)
    providers.add(record.providerID)
    models.set(modelKey(record), { id: modelKey(record), label: record.modelID, providerID: record.providerID })
  }
  const totals = summarize(rows)
  const prompt = totals.tokens.input + totals.tokens.cacheRead + totals.tokens.cacheWrite
  return {
    generatedAt: now,
    timeZone: query.timeZone,
    range: query.range,
    from: date(start),
    to: date(end),
    firstRecord: filtered.length ? date(earliest) : null,
    totals,
    previous,
    cacheHitRate: prompt > 0 ? totals.tokens.cacheRead / prompt : 0,
    activeDays: [...days.values()].filter((value) => value.total > 0).length,
    peakDay: peak && peak[1].total > 0 ? { date: date(peak[0]), total: peak[1].total } : null,
    models: groups(rows, "models", context.available ?? new Set()),
    projects: groups(rows, "projects", context.available ?? new Set()),
    sessions: groups(rows, "sessions", context.available ?? new Set()),
    interval,
    trend: [...buckets.entries()].map(([key, value]) => ({
      date: date(Math.max(key, start)),
      end: date(value.end),
      tokens: value.value.tokens,
      total: value.value.total,
      requests: value.value.requests,
    })),
    activity,
    options: {
      projects: [...projects].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
      providers: [...providers].sort(),
      models: [...models.values()].sort(
        (a, b) => a.label.localeCompare(b.label) || a.providerID.localeCompare(b.providerID),
      ),
    },
    quality: {
      skipped: context.skipped ?? 0,
      historical: rows.filter((record) => record.source === "history").length,
      inherited: context.inherited ?? 0,
    },
  }
}
