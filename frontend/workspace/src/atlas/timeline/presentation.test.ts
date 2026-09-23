import { expect, test } from "bun:test"
import { entry } from "./fixtures"
import { present, requestTitle, statusHint, statusLabel } from "./presentation"
import { rows } from "./model"

const zh = (_en: string, cn: string) => cn
const en = (value: string) => value
const catalog = [{ id: "custom-private-id", name: "Research gateway", models: { model: { name: "Research Model" } } }]

test("renders friendly model and provider names with a safe deleted-provider fallback", () => {
  const model = entry("a", { provider: "custom-private-id", model: "model" })
  expect(present(model, en, catalog).subtitle).toBe("Research Model · Research gateway")
  expect(present(model, zh).subtitle).toBe("model · 自定义供应商")
  expect(present(model, zh).title).toBe("模型分析与响应")
  expect(present(model, zh).subtitle).not.toContain("private-id")
})

test("explains native tools, preserves unknown tool identity, and distinguishes outcomes", () => {
  expect(present(entry("a", { kind: "tool", tool: "skill" }), zh).title).toBe("加载研究技能")
  expect(present(entry("a", { kind: "tool", tool: "bash" }), en).title).toBe("Run terminal command")
  expect(present(entry("a", { kind: "tool", tool: "lab_plugin" }), zh)).toMatchObject({
    title: "调用工具",
    subtitle: "lab_plugin",
  })
  for (const status of ["pending", "running", "completed", "partial", "error", "cancelled", "interrupted"] as const) {
    expect(statusLabel(status, zh)).not.toBe(status)
  }
  expect(statusHint(entry("a", { status: "partial" }), zh)).toContain("仅部分完成")
  expect(statusHint(entry("a", { status: "error" }), zh)).toContain("模型请求失败")
  expect(requestTitle(undefined, zh)).toBe("研究请求")
})

test("search matches localized labels and request summaries without renumbering filtered steps", () => {
  const request = entry("user", { kind: "user", title: "比较样本表达差异" })
  const values = [request, entry("model"), entry("tool", { kind: "tool", tool: "skill", status: "error" })]
  const display = (value: typeof request) => Object.values(present(value, zh)).join(" ")
  const found = rows(values, { msg_turn: true }, "加载研究技能", display)
  expect(found).toHaveLength(2)
  expect(found[0]).toMatchObject({ request, count: 1, issues: 1 })
  expect(found[1]).toMatchObject({ id: "tool", ordinal: 2 })
  expect(rows(values, {}, "样本", display)).toHaveLength(4)
  expect(rows([values[2]], {}, "", display, values)[1]).toMatchObject({ ordinal: 2 })
  expect(rows([values[2]], {}, "", display, values)[0]).toMatchObject({ request })
})
