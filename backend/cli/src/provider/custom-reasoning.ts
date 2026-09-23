import type { Provider } from "./provider"
import { MANAGED_OPENROUTER_MODELS, managedModelDetails } from "./managed-catalog"
import { ProviderTransform } from "./transform"

export function customReasoning(id: string, catalog: Provider.Model[]) {
  // 自定义连接没有供应商目录。只匹配完整模型 ID 或已审核的无前缀 ID，
  // 不按模糊名称给未知模型编造档位，也不复制其他供应商的传输参数。
  const reviewed = MANAGED_OPENROUTER_MODELS.find((key) => key === id || key.slice(key.indexOf("/") + 1) === id)
  const detail = reviewed ? managedModelDetails(reviewed) : undefined
  const source =
    catalog.find((model) => model.id === id && !["openrouter", "opencode"].includes(model.providerID)) ??
    catalog.find((model) => model.id === id || `${model.providerID}/${model.id}` === id)
  const option = source?.reasoningOptions?.find((option) => option.type === "effort")
  const values = detail?.efforts ?? option?.values
  const supported = Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : source
      ? Object.values(ProviderTransform.variants(source)).flatMap((variant) =>
          typeof variant.reasoningEffort === "string" ? [variant.reasoningEffort] : [],
        )
      : []
  const efforts = [...new Set(supported)]
  const preferred = detail?.defaultEffort ?? option?.default
  return {
    reasoning: efforts.length > 0 || source?.capabilities.reasoning === true,
    reasoningOptions: efforts.length
      ? [
          {
            type: "effort",
            values: efforts,
            ...(typeof preferred === "string" && efforts.includes(preferred) ? { default: preferred } : {}),
          },
        ]
      : [],
  }
}
