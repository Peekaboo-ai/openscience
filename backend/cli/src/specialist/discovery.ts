import type { SpecialistSchema } from "./schema"

export type SpecialistSearch = { query?: string; offset?: number; limit?: number }

// 模型只需发现少量相关能力；完整目录仍通过 Settings API 提供给编辑器。
export function specialistPage<T extends { name: string; description?: string; displayName?: string }>(
  entries: T[],
  search: SpecialistSearch,
) {
  const terms = search.query?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? []
  const matches = entries
    .filter((entry) => {
      const text = `${entry.name} ${entry.displayName ?? ""} ${entry.description ?? ""}`.toLocaleLowerCase()
      return terms.every((term) => text.includes(term))
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  const offset = search.offset ?? 0
  const limit = Math.max(1, Math.min(20, search.limit ?? 10))
  return {
    items: matches.slice(offset, offset + limit),
    total: matches.length,
    offset,
    limit,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
  }
}

export function specialistSummary(profile: SpecialistSchema.Profile) {
  return {
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description.slice(0, 240),
    descriptionTruncated: profile.description.length > 240,
    source: profile.source,
    enabled: profile.enabled,
    skills: profile.skillNames?.length ?? "all",
    connectors: profile.connectors?.length ?? "all",
    updatedAt: profile.updatedAt,
  }
}
