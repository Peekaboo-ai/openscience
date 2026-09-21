import type { ExecutionRecord } from "@/science/execution/history"

export type ReplayStep = {
  id: string
  language: string
  kernelID: string
  kernelName?: string
  environment: string
  generation?: number
  policy: "safe" | "manual"
  reason: string
  hash: string
  code: string
}

/** 只接受无调用、无属性访问的字面量赋值；未知代码使已有绑定失信，不能将正则黑名单当作安全分析器。 */
export function literalAssignments(code: string, language: string): boolean {
  if (!["python", "r"].includes(language) || code.length > 32000 || code.includes("[REDACTED]")) return false
  const strings = /"(?:[^"\\\r\n]|\\["\\nrt])*"|'(?:[^'\\\r\n]|\\['\\nrt])*'/g
  const stripped = code.replace(strings, "0")
  const lines = stripped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length || lines.length > 200) return false
  return lines.every((line) => {
    const match = /^([A-Za-z][A-Za-z0-9_]*)\s*(?:=|<-)\s*(.+)$/.exec(line)
    if (!match || (language === "python" && line.includes("<-"))) return false
    // 仅数值、字符串和 Python 字面量容器；禁用指数/乘法以避免恢复过程产生资源放大。
    const value = match[2].replace(/\b(?:True|False|None|TRUE|FALSE|NULL)\b/g, "0")
    if (language === "r") return /^[+-]?\d+(?:\.\d+)?$/.test(value)
    return (
      /^[\d\s.,:\[\]{}()+-]+$/.test(value) &&
      !/[()]\s*[([]/.test(value) &&
      !/\d\s*\(/.test(value) &&
      !/[\]}]\s*\(/.test(value)
    )
  })
}

export function replayPlan(records: ExecutionRecord[]): ReplayStep[] {
  const latest = new Map<string, number>()
  for (const record of records) {
    if (record.environment.kernel_id.status !== "available" || record.environment.incarnation.status !== "available")
      continue
    latest.set(
      record.environment.kernel_id.value,
      Math.max(latest.get(record.environment.kernel_id.value) ?? 0, record.environment.incarnation.value),
    )
  }
  const steps = records.map((record) => {
    const code = record.code.status === "available" ? record.code.value : ""
    const kernelID = record.environment.kernel_id.status === "available" ? record.environment.kernel_id.value : ""
    const generation =
      record.environment.incarnation.status === "available" ? record.environment.incarnation.value : undefined
    const reason =
      !kernelID || !generation
        ? "Missing kernel generation"
        : generation !== latest.get(kernelID)
          ? "Superseded kernel generation"
          : record.status !== "succeeded"
            ? "Execution did not succeed"
            : record.files.length
              ? "Execution changed files"
              : !literalAssignments(code, record.language)
                ? "Requires manual review: calls, dependencies, imports or nonliteral state"
                : "Independent literal assignments; no external effects"
    return {
      id: record.id,
      language: record.language,
      kernelID,
      generation,
      environment: record.environment.name.status === "available" ? record.environment.name.value : record.language,
      policy: reason.startsWith("Independent") ? "safe" : "manual",
      reason,
      hash: new Bun.CryptoHasher("sha256").update(code).digest("hex"),
      code,
    } as ReplayStep
  })
  // 后续未知代码可能修改先前绑定；宁可减少恢复内容，也不能将过期变量报告为恢复成功。
  const tainted = new Set<string>()
  for (const step of [...steps].reverse()) {
    const key = `${step.kernelID}:${step.generation}`
    if (step.policy === "manual" && step.generation === latest.get(step.kernelID)) tainted.add(key)
    if (step.policy === "safe" && tainted.has(key)) {
      step.policy = "manual"
      step.reason = "A later non-replayable cell may have modified this state"
    }
  }
  return steps
}
