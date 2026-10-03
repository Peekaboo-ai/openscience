import { describe, expect, test } from "bun:test"
import { buildUsageReport, modelKey } from "../../src/session/usage-stats-report"
import { UsageQuery, UsageRecord, UsageReport } from "../../src/session/usage-stats-schema"

const now = Date.parse("2026-09-30T16:30:00Z")
const record = (patch: Partial<UsageRecord> = {}): UsageRecord => ({
  id: crypto.randomUUID(),
  projectID: "project-a",
  projectName: "Bio",
  sessionID: "session-a",
  sessionTitle: "Docking",
  messageID: "message-a",
  providerID: "openai",
  modelID: "model-a",
  route: "byok",
  kind: "session",
  source: "response",
  occurredAt: now - 1_000,
  reported: true,
  tokens: { input: 200, output: 100, reasoning: 30, cacheRead: 700, cacheWrite: 100 },
  ...patch,
})
const query = (patch: Partial<UsageQuery> = {}) =>
  UsageQuery.parse({ range: "7d", timeZone: "Asia/Hong_Kong", ...patch })

describe("usage statistics accounting", () => {
  test("counts all prompt tokens once and reasoning as an output subset", () => {
    const report = buildUsageReport([record()], query(), { now })
    expect(report.totals.total).toBe(1_100)
    expect(report.totals.tokens.output).toBe(100)
    expect(report.totals.tokens.reasoning).toBe(30)
    expect(report.cacheHitRate).toBeCloseTo(0.7)
    expect(report.totals.requests).toBe(1)
    expect(report.totals.sessions).toBe(1)
    expect(UsageReport.safeParse(report).success).toBe(true)
  })

  test("every model, project, session, trend and heatmap reconciles to the summary", () => {
    const records = [
      record(),
      record({ modelID: "model-b", sessionID: "session-b" }),
      record({ projectID: "project-b", projectName: "Materials", providerID: "anthropic", kind: "background" }),
    ]
    const report = buildUsageReport(records, query(), { now, available: new Set(["session-a"]) })
    for (const group of [report.models, report.projects, report.sessions, report.trend, report.activity]) {
      expect(group.reduce((sum, value) => sum + value.total, 0)).toBe(report.totals.total)
      expect(group.reduce((sum, value) => sum + value.requests, 0)).toBe(report.totals.requests)
    }
    expect(report.totals.sessions).toBe(2)
    expect(report.totals.background).toBe(1)
    expect(report.sessions.find((row) => row.id === "session-b")?.available).toBe(false)
  })

  test("same model name across providers stays separate and filters compose", () => {
    const a = record()
    const b = record({ providerID: "gateway", sessionID: "session-b" })
    const c = record({ projectID: "project-b" })
    const report = buildUsageReport(
      [a, b, c],
      query({ project: "project-a", provider: "openai", model: modelKey(a) }),
      { now },
    )
    expect(report.totals.requests).toBe(1)
    expect(report.models[0].id).toBe(modelKey(a))
    expect(report.options.models).toHaveLength(2)
    expect(report.options.projects).toHaveLength(2)
  })

  test("missing usage is visible and reports only token accounting", () => {
    const report = buildUsageReport([record({ reported: false }), record()], query(), { now, skipped: 2 })
    expect(report.totals).not.toHaveProperty("cost")
    expect(report.totals).not.toHaveProperty("priced")
    expect(report.totals.unreported).toBe(1)
    expect(report.quality.skipped).toBe(2)
  })

  test("uses calendar days in the selected time zone and an equally long previous period", () => {
    const report = buildUsageReport(
      [
        record({ occurredAt: Date.parse("2026-09-30T15:59:00Z") }),
        record({ occurredAt: Date.parse("2026-09-30T16:01:00Z") }),
        record({ occurredAt: Date.parse("2026-09-23T15:59:00Z") }),
        record({ occurredAt: now + 1 }),
      ],
      query(),
      { now },
    )
    expect(report.to).toBe("2026-10-01")
    expect(report.from).toBe("2026-09-25")
    expect(report.trend).toHaveLength(7)
    expect(report.trend.at(-1)?.requests).toBe(1)
    expect(report.trend.at(-2)?.requests).toBe(1)
    expect(report.previous?.requests).toBe(1)
  })

  test("handles DST changes with each record's local date", () => {
    const records = [
      record({ occurredAt: Date.parse("2026-03-08T07:30:00Z") }),
      record({ occurredAt: Date.parse("2026-03-09T03:30:00Z") }),
      record({ occurredAt: Date.parse("2026-03-09T04:30:00Z") }),
    ]
    const report = buildUsageReport(
      records,
      query({ range: "custom", timeZone: "America/New_York", from: "2026-03-08", to: "2026-03-08" }),
      { now },
    )
    expect(report.totals.requests).toBe(2)
    expect(report.trend).toHaveLength(1)
    const repeated = buildUsageReport(
      [
        record({ occurredAt: Date.parse("2026-11-01T05:30:00Z") }),
        record({ occurredAt: Date.parse("2026-11-01T06:30:00Z") }),
      ],
      query({ range: "today", timeZone: "America/New_York" }),
      { now: Date.parse("2026-11-01T23:00:00Z") },
    )
    expect(repeated.totals.requests).toBe(2)
  })

  test("fills empty dates and returns an explicit empty result", () => {
    const report = buildUsageReport([], query(), { now })
    expect(report.totals.requests).toBe(0)
    expect(report.firstRecord).toBeNull()
    expect(report.peakDay).toBeNull()
    expect(report.trend.every((day) => day.total === 0)).toBe(true)
    expect(report.activity).toHaveLength(7)
    expect(UsageReport.safeParse(report).success).toBe(true)
  })

  test("long histories use bounded monthly trends and one year of activity", () => {
    const records = [record({ occurredAt: Date.parse("2020-01-01T00:00:00Z") }), record()]
    const report = buildUsageReport(records, query({ range: "all" }), { now })
    expect(report.interval).toBe("month")
    expect(report.trend.length).toBeLessThan(100)
    expect(report.activity).toHaveLength(364)
    expect(report.trend.reduce((sum, item) => sum + item.total, 0)).toBe(report.totals.total)
    expect(report.previous).toBeNull()
  })

  test("rejects invalid zones, reversed, invalid calendar and excessive date ranges", () => {
    for (const input of [
      { timeZone: "Invalid/Zone" },
      { range: "custom", from: "2026-09-30", to: "2026-09-01" },
      { range: "custom", from: "2026-02-30", to: "2026-03-01" },
      { range: "custom", from: "2000-01-01", to: "2026-01-01" },
      { range: "custom" },
    ])
      expect(UsageQuery.safeParse(input).success).toBe(false)
  })
})
