import { describe, expect, test } from "bun:test"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { dict as en } from "./en"
import { dict as uiEn } from "@synsci/ui/i18n/en"
import { translationKeys } from "../../test/i18n-keys"

// The translators fall back to English for any key a locale lacks, so English
// is the one dictionary every referenced key must exist in. Keys assembled at
// runtime from template strings are typed against the dictionary instead.
const roots = ["..", "../../../ui/src"].map((relative) => fileURLToPath(new URL(relative, import.meta.url)))

function sources(dir: string, into: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== "node_modules" && entry !== "i18n") sources(path, into)
      continue
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) into.push(path)
  }
  return into
}

describe("interface copy keys", () => {
  test("extracts dictionary calls, interpolated lookups and literal template keys", () => {
    expect(
      translationKeys('t("common.save"); language.t("session.count", { count: 2 }); i18n["t"](`ui.close`)'),
    ).toEqual(["common.save", "session.count", "ui.close"])
  })

  test("local bilingual helpers do not hide dictionary lookups in the same file", () => {
    const source = `
      const t = (en: string, zh: string) => locale === "zh" ? zh : en
      t("Queued messages", "待发送消息")
      props.t("Run after this task", "当前任务完成后执行")
      language.t("session.modelSwitch.changed", { from: "A", to: "B" })
      language.t("missing.key")
    `
    expect(translationKeys(source)).toEqual(["session.modelSwitch.changed", "missing.key"])
  })

  test("ignores comments, quoted examples and JSX text while reading JSX expressions", () => {
    const source = `
      // t("comment.example")
      /* language.t("another.comment") */
      const example = 't("quoted.example")'
      const view = <div>t("jsx.example"){language.t("common.close")}</div>
    `
    expect(translationKeys(source)).toEqual(["common.close"])
  })

  test("retains unknown and escaped static keys while leaving dynamic keys to typechecking", () => {
    expect(translationKeys('t("missing\\u002ekey"); language.t(key); language.t(`session.${state}`)')).toEqual([
      "missing.key",
    ])
  })

  test("parses TypeScript generics using the source file's syntax", () => {
    expect(translationKeys('const identity = <T>(value: T) => value; t("common.save")', "helper.ts")).toEqual([
      "common.save",
    ])
  })

  test('every key referenced by t("…") in the workspace and ui sources exists in English', async () => {
    const known = new Set([...Object.keys(en), ...Object.keys(uiEn)])
    const missing: string[] = []
    let references = 0
    for (const file of roots.flatMap((root) => sources(root))) {
      const text = await Bun.file(file).text()
      for (const key of translationKeys(text, file)) {
        references++
        if (!known.has(key)) missing.push(`${file}: ${key}`)
      }
    }
    expect(references).toBeGreaterThan(100)
    expect(missing).toEqual([])
  })
})
