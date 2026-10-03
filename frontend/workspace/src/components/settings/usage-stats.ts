import type { UsageStatsReport } from "@synsci/sdk/v2"

export type UsageReport = UsageStatsReport
export type UsageRange = NonNullable<UsageReport["range"]>
export type UsageGroup = UsageReport["models"][number]
export type UsageQuery = {
  range: UsageRange
  from: string
  to: string
  project: string
  provider: string
  model: string
}
export const USAGE_RANGES: { id: UsageRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom" },
]
export const USAGE_SERIES = [
  { key: "input", label: "Uncached input", color: "input" },
  { key: "output", label: "Output", color: "output" },
  { key: "cacheRead", label: "Cache read", color: "read" },
  { key: "cacheWrite", label: "Cache write", color: "write" },
] as const

export function usagePath(query: UsageQuery, timeZone: string, refresh = false) {
  const params = new URLSearchParams({ range: query.range, timeZone })
  for (const key of ["project", "provider", "model"] as const) if (query[key]) params.set(key, query[key])
  if (query.range === "custom") {
    params.set("from", query.from)
    params.set("to", query.to)
  }
  if (refresh) params.set("refresh", "1")
  return `/settings/usage-stats?${params}`
}

export function validUsageRange(query: UsageQuery) {
  if (query.range !== "custom") return true
  const start = Date.parse(query.from)
  const end = Date.parse(query.to)
  return Number.isFinite(start) && Number.isFinite(end) && start <= end && end - start <= 3_660 * 86_400_000
}

export function formatTokens(value: number, compact = true) {
  return new Intl.NumberFormat(
    undefined,
    compact && value >= 10_000
      ? { notation: "compact", maximumFractionDigits: value < 1_000_000 ? 1 : 2 }
      : { maximumFractionDigits: 0 },
  ).format(value)
}

export function usageChange(current: number, previous: number | undefined) {
  if (previous === undefined || previous === 0) return undefined
  const value = (current - previous) / previous
  return `${value > 0 ? "+" : ""}${new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value)}`
}

export function csvCell(value: string | number) {
  const text = typeof value === "string" && /^[\s]*[=+\-@]/.test(value) ? `'${value}` : String(value)
  return `"${text.replaceAll('"', '""')}"`
}

export function usageCSV(report: UsageReport, kind: "models" | "projects" | "sessions", entries = report[kind]) {
  const header = [
    "From",
    "To",
    "Time zone",
    "Group",
    "Name",
    "Provider / project",
    "ID",
    "Requests",
    "Sessions",
    "Total tokens",
    "Uncached input",
    "Output (includes reasoning)",
    "Reasoning",
    "Cache read",
    "Cache write",
    "Incomplete / historical usage",
  ]
  const rows = entries.map((row) => [
    report.from,
    report.to,
    report.timeZone,
    kind,
    row.label,
    row.secondary,
    row.id,
    row.requests,
    row.sessions,
    row.total,
    row.tokens.input,
    row.tokens.output,
    row.tokens.reasoning,
    row.tokens.cacheRead,
    row.tokens.cacheWrite,
    row.unreported,
  ])
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`
}
