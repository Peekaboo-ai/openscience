import z from "zod"

const count = z.number().finite().nonnegative()
export const UsageTokens = z.object({
  input: count,
  output: count,
  reasoning: count,
  cacheRead: count,
  cacheWrite: count,
})
export type UsageTokens = z.infer<typeof UsageTokens>

export const UsageRecord = z.object({
  id: z.string().regex(/^[\w-]+$/),
  projectID: z.string(),
  projectName: z.string(),
  sessionID: z.string(),
  sessionTitle: z.string(),
  parentID: z.string().optional(),
  messageID: z.string(),
  providerID: z.string(),
  modelID: z.string(),
  route: z.string(),
  kind: z.enum(["session", "background"]),
  source: z.enum(["response", "history"]),
  historyComplete: z.boolean().optional(),
  occurredAt: count,
  tokens: UsageTokens,
  reported: z.boolean(),
})
export type UsageRecord = z.infer<typeof UsageRecord>

export function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  )
}

export function validZone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

export const UsageQuery = z
  .object({
    range: z.enum(["today", "7d", "30d", "90d", "all", "custom"]).default("30d"),
    timeZone: z.string().max(100).refine(validZone, "Invalid time zone").default("UTC"),
    from: z.string().refine(validDate, "Invalid start date").optional(),
    to: z.string().refine(validDate, "Invalid end date").optional(),
    project: z.string().max(200).optional(),
    provider: z.string().max(200).optional(),
    model: z.string().max(500).optional(),
  })
  .superRefine((value, context) => {
    if (value.range !== "custom") return
    if (!value.from || !value.to || value.from > value.to) {
      context.addIssue({ code: "custom", message: "Choose a valid date range", path: ["from"] })
    }
    if (value.from && value.to && Date.parse(value.to) - Date.parse(value.from) > 3_660 * 86_400_000) {
      context.addIssue({ code: "custom", message: "Date range cannot exceed ten years", path: ["to"] })
    }
  })
export type UsageQuery = z.infer<typeof UsageQuery>

export const UsageTotals = z.object({
  tokens: UsageTokens,
  total: count,
  requests: count,
  sessions: count,
  unreported: count,
  background: count,
})
export type UsageTotals = z.infer<typeof UsageTotals>

const Group = UsageTotals.extend({
  id: z.string(),
  label: z.string(),
  secondary: z.string(),
  projectID: z.string().optional(),
  providerID: z.string().optional(),
  modelID: z.string().optional(),
  lastUsed: count,
  available: z.boolean(),
})
export const UsageReport = z
  .object({
    generatedAt: count,
    timeZone: z.string(),
    range: UsageQuery.shape.range.removeDefault(),
    from: z.string(),
    to: z.string(),
    firstRecord: z.string().nullable(),
    totals: UsageTotals,
    previous: UsageTotals.nullable(),
    cacheHitRate: count,
    activeDays: count,
    peakDay: z.object({ date: z.string(), total: count }).nullable(),
    models: Group.array(),
    projects: Group.array(),
    sessions: Group.array(),
    trend: z.object({ date: z.string(), end: z.string(), tokens: UsageTokens, total: count, requests: count }).array(),
    interval: z.enum(["day", "week", "month"]),
    activity: z
      .object({ date: z.string(), total: count, requests: count, level: z.number().int().min(0).max(4) })
      .array(),
    options: z.object({
      projects: z.object({ id: z.string(), label: z.string() }).array(),
      providers: z.string().array(),
      models: z.object({ id: z.string(), label: z.string(), providerID: z.string() }).array(),
    }),
    quality: z.object({ skipped: count, historical: count, inherited: count }),
  })
  .meta({ ref: "UsageStatsReport" })
export type UsageReport = z.infer<typeof UsageReport>
