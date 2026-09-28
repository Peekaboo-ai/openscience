// 改编自 ZCode model-anomaly.ts 的 stableJson；Apache-2.0，归属信息见 NOTICE。
// 参数字段顺序不应改变行动身份，数组顺序则必须保留。
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}
