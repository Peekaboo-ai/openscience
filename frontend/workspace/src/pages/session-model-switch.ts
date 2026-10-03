import type { ModelKey } from "@/context/model-catalog"

export type ModelTurn = { id: string; model: ModelKey }
export type ModelSwitch = { from: ModelKey; to: ModelKey }
export type ModelSwitchDraft = { after: string; to: ModelKey }
export type ModelSwitchDrafts = Record<string, ModelSwitchDraft | undefined>

export function sameModel(a: ModelKey | undefined, b: ModelKey | undefined) {
  return !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID
}

export function sessionModelSwitches(turns: readonly ModelTurn[]) {
  const before: Record<string, ModelSwitch> = {}
  for (let i = 1; i < turns.length; i++) {
    const previous = turns[i - 1].model
    const current = turns[i].model
    if (!sameModel(previous, current)) before[turns[i].id] = { from: previous, to: current }
  }
  return { before, last: turns.at(-1) }
}

export function rememberModelSwitch(drafts: ModelSwitchDrafts, id: string, last: ModelTurn | undefined, to: ModelKey) {
  // 草稿只保留最后选择；发送后的正式记录由消息中的模型字段还原，不额外写入对话内容。
  const entries = Object.entries(drafts).filter(([key, value]) => key !== id && value)
  if (last && !sameModel(last.model, to)) entries.push([id, { after: last.id, to }])
  return Object.fromEntries(entries.slice(-40))
}

export function pendingModelSwitch(
  last: ModelTurn | undefined,
  draft: ModelSwitchDraft | undefined,
  current: ModelKey | undefined,
) {
  // 不把其他会话的全局模型选择、目录刷新或发送前的旧草稿误报为本会话的新切换。
  if (!last || !draft || draft.after !== last.id || !sameModel(draft.to, current) || sameModel(last.model, draft.to))
    return
  return { from: last.model, to: draft.to }
}

type ProviderNames = { id: string; name: string; models: Record<string, { name: string }> }

export function modelSwitchLabels(change: ModelSwitch, providers: readonly ProviderNames[]) {
  const label = (model: ModelKey) => {
    const provider = providers.find((entry) => entry.id === model.providerID)
    return {
      name: provider?.models[model.modelID]?.name || model.modelID,
      provider: provider?.name || model.providerID,
    }
  }
  const from = label(change.from)
  const to = label(change.to)
  const distinguish = from.name === to.name && change.from.providerID !== change.to.providerID
  return {
    from: distinguish ? `${from.name} (${from.provider})` : from.name,
    to: distinguish ? `${to.name} (${to.provider})` : to.name,
    detail: `${from.name} · ${from.provider} → ${to.name} · ${to.provider}`,
  }
}
