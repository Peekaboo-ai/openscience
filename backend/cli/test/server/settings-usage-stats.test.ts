import { afterAll, describe, expect, test } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { UsageStats } from "../../src/session/usage-stats"
import { UsageQuery, UsageRecord } from "../../src/session/usage-stats-schema"
import { UsageStatsRoutes } from "../../src/server/routes/settings/usage-stats"

const suffix = crypto.randomUUID().replaceAll("-", "")
const projectID = `prj_usage_${suffix}`
const sessionID = `ses_usage_${suffix}`
const messageID = `msg_usage_${suffix}`
const keys: string[][] = []
const save = async (key: string[], value: unknown) => {
  keys.push(key)
  await Storage.write(key, value)
}
const query = UsageQuery.parse({ range: "all", timeZone: "UTC", project: projectID })
const tokens = { input: 100, output: 20, reasoning: 10, cache: { read: 80, write: 30 } }
afterAll(async () => {
  for (const key of [...keys, ...(await Storage.list(["usage"]))]) {
    if (key[0] === "usage") {
      const record = await Storage.read<UsageRecord>(key).catch(() => undefined)
      if (record?.projectID !== projectID) continue
    }
    await Storage.remove(key)
  }
})

describe("settings usage history and durable ledger", () => {
  test("backfills every step, skips inherited messages and retains usage after deletion", async () => {
    const at = Date.now() - 20_000
    await save(["project", projectID], { id: projectID, name: "Bio usage fixture", worktree: "/bio" })
    await save(["session", projectID, sessionID], {
      id: sessionID,
      projectID,
      title: "Research",
      time: { created: at },
    })
    const assistant = {
      id: messageID,
      sessionID,
      role: "assistant",
      providerID: "provider",
      modelID: "model",
      tokens,
      cost: 0.5,
      time: { created: at + 1_000, completed: at + 2_000 },
    }
    await save(["message", sessionID, messageID], assistant)
    await save(["part", messageID, "part-usage-a"], {
      id: `part-usage-a-${suffix}`,
      type: "step-finish",
      tokens,
      cost: 0.2,
    })
    await save(["part", messageID, "part-usage-b"], {
      id: `part-usage-b-${suffix}`,
      type: "step-finish",
      tokens,
      cost: 0.3,
    })
    const forkID = `ses_fork_${suffix}`
    await save(["session", projectID, forkID], { id: forkID, projectID, title: "Fork", time: { created: at + 10_000 } })
    await save(["message", forkID, `msg_fork_${suffix}`], { ...assistant, id: `msg_fork_${suffix}`, sessionID: forkID })
    const first = await UsageStats.report(query, true)
    expect(first.totals.requests).toBe(2)
    expect(first.totals.total).toBe(460)
    expect(first.totals).not.toHaveProperty("cost")
    for (const key of await Storage.list(["usage"])) {
      const record = await Storage.read<UsageRecord>(key)
      if (record.projectID === projectID) expect(record).not.toHaveProperty("cost")
    }
    expect(first.quality.inherited).toBeGreaterThan(0)
    expect((await UsageStats.report(query, true)).totals.total).toBe(460)
    await Storage.remove(["session", projectID, sessionID])
    await Storage.remove(["message", sessionID, messageID])
    const retained = await UsageStats.report(query, true)
    expect(retained.totals.total).toBe(460)
    expect(retained.sessions[0].available).toBe(false)
  })

  test("a live response replaces imported message usage and counts background calls", async () => {
    const at = Date.now() - 10_000
    await save(["session", projectID, sessionID], {
      id: sessionID,
      projectID,
      title: "Research renamed",
      time: { created: at },
    })
    await UsageStats.record({
      id: `usage_test_${suffix}`,
      projectID,
      projectName: "Bio",
      sessionID,
      messageID,
      providerID: "provider",
      modelID: "model",
      route: "byok",
      kind: "session",
      usage: { inputTokens: 210, outputTokens: 20, totalTokens: 230, reasoningTokens: 10, cachedInputTokens: 80 },
      tokens,
    })
    await UsageStats.record({
      id: `usage_title_${suffix}`,
      projectID,
      projectName: "Bio",
      sessionID,
      messageID,
      providerID: "provider",
      modelID: "model",
      route: "local",
      kind: "background",
      usage: {
        inputTokens: undefined,
        outputTokens: 5,
        totalTokens: undefined,
        reasoningTokens: undefined,
        cachedInputTokens: undefined,
      },
      tokens: { input: 0, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const report = await UsageStats.report(query, true)
    expect(report.totals.requests).toBe(2)
    expect(report.totals.total).toBe(235)
    expect(report.totals).not.toHaveProperty("priced")
    expect(report.totals.background).toBe(1)
    expect(report.sessions[0].label).toBe("Research renamed")
    expect(report.totals.unreported).toBe(1)
    expect(report.quality.historical).toBe(0)
  })

  test("serves the actual report and validates timezone and dates at the HTTP boundary", async () => {
    const response = await UsageStatsRoutes().request(`/?range=all&project=${projectID}&timeZone=UTC`)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect((await response.json()).totals.total).toBe(235)
    for (const search of [
      "timeZone=Bad/Zone",
      "range=custom&from=2026-09-30&to=2026-09-01",
      "range=custom&from=2026-02-30&to=2026-03-01",
    ]) {
      expect((await UsageStatsRoutes().request(`/?${search}`)).status).toBe(400)
    }
  })
})
