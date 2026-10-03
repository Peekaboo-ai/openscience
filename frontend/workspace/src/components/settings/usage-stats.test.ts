import { expect, test } from "bun:test"
import { csvCell, formatTokens, usageChange, usagePath, validUsageRange, type UsageQuery } from "./usage-stats"

const query: UsageQuery = { range: "30d", from: "2026-09-01", to: "2026-09-30", project: "", provider: "", model: "" }

test("usage queries carry the timezone and selected dimensions without leaking custom dates", () => {
  const params = new URL(
    usagePath({ ...query, project: "prj bio", model: '["gateway","model/a"]' }, "Asia/Hong_Kong"),
    "http://localhost",
  ).searchParams
  expect(params.get("timeZone")).toBe("Asia/Hong_Kong")
  expect(params.get("project")).toBe("prj bio")
  expect(params.get("model")).toBe('["gateway","model/a"]')
  expect(params.has("from")).toBe(false)
  const custom = new URL(usagePath({ ...query, range: "custom" }, "UTC", true), "http://localhost").searchParams
  expect(custom.get("from")).toBe("2026-09-01")
  expect(custom.get("to")).toBe("2026-09-30")
  expect(custom.get("refresh")).toBe("1")
})

test("token formatting retains zero and comparison has no divide by zero", () => {
  expect(formatTokens(0)).toBe("0")
  expect(formatTokens(1_234, false)).toBe("1,234")
  expect(usageChange(100, 0)).toBeUndefined()
  expect(usageChange(150, 100)).toContain("50")
  expect(usageChange(50, 100)).toContain("-")
})

test("custom range validation blocks empty, reversed and excessive intervals", () => {
  expect(validUsageRange({ ...query, range: "custom" })).toBe(true)
  for (const range of [{ from: "" }, { to: "2026-08-01" }, { from: "2000-01-01" }]) {
    expect(validUsageRange({ ...query, ...range, range: "custom" })).toBe(false)
  }
})

test("CSV escaping retains delimiters and protects against spreadsheet formulas", () => {
  expect(csvCell('name, "quoted"\nnext')).toBe('"name, ""quoted""\nnext"')
  for (const value of ["=SUM(A1)", " +CMD", "\t@value", "-formula"]) expect(csvCell(value)).toStartWith("\"'")
  expect(csvCell(1_000)).toBe('"1000"')
  expect(csvCell("科研结果")).toBe('"科研结果"')
})
