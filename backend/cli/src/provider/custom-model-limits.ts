import z from "zod"
import type { ModelsDev } from "./models"
import { MANAGED_OPENROUTER_MODELS, managedModelDetails } from "./managed-catalog"

export namespace CustomModelLimits {
  const tokens = z.number().int().positive().max(2_147_483_647)
  export const Limit = z
    .object({ context: tokens.min(1024), output: tokens, input: tokens.optional() })
    .refine((value) => value.output <= value.context && (!value.input || value.input <= value.context), {
      message: "Input and output limits must not exceed the context window.",
    })
  export const Choice = Limit.safeExtend({
    mode: z.enum(["auto", "manual"]),
    source: z.enum(["catalog", "endpoint", "fallback", "manual"]),
  })
  export type Choice = z.infer<typeof Choice>
  type Catalog = Record<string, ModelsDev.Provider>
  type Bounds = z.infer<typeof Limit>
  const indexes = new WeakMap<Catalog, Map<string, Bounds>>()

  function index(catalog: Catalog) {
    const cached = indexes.get(catalog)
    if (cached) return cached
    const result = new Map<string, Bounds>()
    const providers = Object.values(catalog).sort(
      (a, b) => Number(["openrouter", "opencode"].includes(a.id)) - Number(["openrouter", "opencode"].includes(b.id)),
    )
    for (const provider of providers) {
      for (const [id, model] of Object.entries(provider.models)) {
        const limit = Limit.safeParse(model.limit)
        if (!limit.success) continue
        for (const key of [id, `${provider.id}/${model.id}`]) {
          if (!result.has(key)) result.set(key, limit.data)
        }
      }
    }
    indexes.set(catalog, result)
    return result
  }

  export function defaults(id: string, catalog: Catalog): Choice {
    const reviewed = MANAGED_OPENROUTER_MODELS.find((key) => key === id || key.slice(key.indexOf("/") + 1) === id)
    const detail = reviewed ? managedModelDetails(reviewed) : undefined
    if (detail)
      return {
        context: detail.context,
        output: detail.output,
        ...(detail.maxInput ? { input: detail.maxInput } : {}),
        mode: "auto",
        source: "catalog",
      }
    const limit = index(catalog).get(id)
    if (limit) return { ...limit, mode: "auto", source: "catalog" }
    // 未知模型沿用原始上下文预算回退；明确标注未验证，不把它当成模型的真实上限。
    return { context: 128_000, output: 32_000, mode: "auto", source: "fallback" }
  }

  export function configured(id: string, limit: Bounds | undefined, metadata: unknown, catalog: Catalog): Choice {
    const info = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : undefined
    const legacyDefault = !info && limit?.context === 32768 && limit.output === 8192
    const valid = Limit.safeParse(limit)
    if (valid.success && (info?.mode === "manual" || (!info && !legacyDefault)))
      return { ...valid.data, mode: "manual", source: "manual" }
    if (valid.success && info?.source === "endpoint") return { ...valid.data, mode: "auto", source: "endpoint" }
    return defaults(id, catalog)
  }

  export function discovered(id: string, entry: unknown, catalog: Catalog): Choice {
    const base = defaults(id, catalog)
    if (!entry || typeof entry !== "object") return base
    const object = entry as Record<string, unknown>
    const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {})
    const limit = record(object.limit ?? object.limits)
    const top = record(object.top_provider)
    const positive = (value: unknown) => (tokens.safeParse(value).success ? (value as number) : undefined)
    const reportedContext = positive(limit.context ?? object.context_length ?? object.max_context_length)
    const context = reportedContext && reportedContext >= 1024 ? reportedContext : undefined
    const output = positive(limit.output ?? object.max_output_tokens ?? top.max_completion_tokens)
    const input = positive(limit.input ?? object.max_input_tokens ?? top.max_prompt_tokens)
    if (!context && !output && !input) return base
    const capacity = context ?? base.context
    return {
      context: capacity,
      output: Math.min(output ?? base.output, capacity),
      ...(input ? { input: Math.min(input, capacity) } : base.input ? { input: Math.min(base.input, capacity) } : {}),
      mode: "auto",
      source: "endpoint",
    }
  }
}
