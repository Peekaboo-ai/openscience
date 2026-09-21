import { describe, expect, test } from "bun:test"
import {
  domain,
  duration,
  matches,
  mergePages,
  rows,
  segments,
  tokenTotal,
  zoom,
  pan,
  type Entry,
  type Page,
} from "./model"

import { entry, page } from "./fixtures"

describe("action timeline geometry and ledger", () => {
  test("only draws measured phases and handles missing/reversed times", () => {
    expect(segments(entry("a"), 3000)).toEqual([{ phase: "inference", start: 1000, end: 2000 }])
    expect(segments(entry("a", { responseAt: 1500 }), 3000)).toHaveLength(2)
    expect(segments(entry("a", { completedAt: 900 }), 3000)).toEqual([])
    expect(duration(entry("a", { completedAt: undefined, status: "interrupted" }), 3000)).toBeUndefined()
    expect(duration(entry("a", { completedAt: undefined, status: "running" }), 3000)).toBe(2000)
    expect(domain([], 1000)).toEqual({ start: 1000, end: 1001 })
  })
  test("token total includes cache but not reasoning twice", () => {
    expect(
      tokenTotal(entry("a", { tokens: { input: 10, output: 20, reasoning: 5, cacheRead: 30, cacheWrite: 4 } })),
    ).toBe(64)
    expect(tokenTotal(entry("a"))).toBeUndefined()
  })
  test("search temporarily expands collapsed turns and matches all terms", () => {
    const values = [entry("a"), entry("b", { title: "R analysis" })]
    expect(rows(values, { msg_turn: true })).toHaveLength(1)
    expect(rows(values, { msg_turn: true }, "python analysis")).toHaveLength(2)
    expect(rows(values, { msg_turn: true })).toHaveLength(1)
    expect(matches(values[0], "python missing")).toBe(false)
  })
  test("deduplicates overlapping pages and bounds zoom", () => {
    expect(mergePages([page(["msg_2", "msg_3"]), page(["msg_1", "msg_2"])]).map((item) => item.id)).toEqual([
      "msg_1",
      "msg_2",
      "msg_3",
    ])
    expect(zoom({ start: 0, end: 100 }, 0.5)).toEqual({ start: 25, end: 75 })
    expect(pan({ start: 0, end: 100 }, 0.5)).toEqual({ start: 50, end: 150 })
    const small = zoom({ start: 0, end: 1 }, 0.001)
    expect(small.end - small.start).toBe(1)
  })
})
