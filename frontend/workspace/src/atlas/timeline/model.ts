import type { ActionTimelineEntry, ActionTimelinePage } from "@synsci/sdk/v2/client"

export type Entry = ActionTimelineEntry
export type Page = ActionTimelinePage
export type Window = { start: number; end: number }
export type Row = { type: "turn"; id: string; count: number } | { type: "entry"; id: string; entry: Entry }
export const ROW_HEIGHT = 46

export function duration(entry: Entry, now: number) {
  if (entry.startedAt === undefined) return undefined
  const end = entry.completedAt ?? (entry.status === "running" ? now : undefined)
  return end === undefined || end < entry.startedAt ? undefined : end - entry.startedAt
}

export function formatDuration(ms: number | undefined) {
  return ms === undefined || !Number.isFinite(ms)
    ? "—"
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(1)} s`
}

export function tokenTotal(entry: Entry) {
  const tokens = entry.tokens
  // reasoning 是 output 的子集，不能重复计入；缓存 token 独立报告。
  return tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite : undefined
}

export function domain(entries: Entry[], now: number): Window {
  const starts = entries.flatMap((entry) => (entry.startedAt === undefined ? [] : [entry.startedAt]))
  const ends = entries.flatMap((entry) =>
    entry.startedAt === undefined ? [] : [entry.completedAt ?? (entry.status === "running" ? now : entry.startedAt)],
  )
  const start = starts.length ? starts.reduce((value, item) => Math.min(value, item), Infinity) : now
  return { start, end: ends.reduce((value, item) => Math.max(value, item), start + 1) }
}

export function zoom(window: Window, factor: number, anchor = 0.5): Window {
  const span = Math.min(365 * 86400_000, Math.max(1, (window.end - window.start) * factor))
  const point = window.start + (window.end - window.start) * anchor
  return { start: point - span * anchor, end: point + span * (1 - anchor) }
}

export function pan(window: Window, fraction: number): Window {
  const delta = (window.end - window.start) * fraction
  return { start: window.start + delta, end: window.end + delta }
}

export function matches(entry: Entry, query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const document = [
    entry.title,
    entry.kind,
    entry.status,
    entry.owner,
    entry.tool,
    entry.model,
    ...entry.resources,
    ...entry.artifacts,
  ]
    .join(" ")
    .toLocaleLowerCase()
  return terms.every((term) => document.includes(term))
}

export function rows(entries: Entry[], collapsed: Record<string, boolean>, query = ""): Row[] {
  const turns = new Map<string, Entry[]>()
  for (const entry of entries) {
    if (!matches(entry, query)) continue
    const group = turns.get(entry.turnID) ?? []
    group.push(entry)
    turns.set(entry.turnID, group)
  }
  return [...turns].flatMap(([id, entries]): Row[] => [
    { type: "turn", id, count: entries.length },
    ...(collapsed[id] && !query.trim() ? [] : entries.map((entry): Row => ({ type: "entry", id: entry.id, entry }))),
  ])
}

export function segments(entry: Entry, now: number) {
  const start = entry.startedAt
  if (start === undefined) return []
  const end = entry.completedAt ?? (entry.status === "running" ? now : start)
  if (end < start) return []
  const response = entry.responseAt
  if (entry.kind === "inference" && response !== undefined && response >= start && response <= end)
    return [
      { phase: "response", start, end: response },
      { phase: "decode", start: response, end },
    ]
  return [{ phase: entry.kind === "inference" ? "inference" : "execution", start, end }]
}

export function overviewPaths(entries: Entry[], window: Window, now: number) {
  const paths: Record<string, string[]> = {}
  const span = window.end - window.start
  const height = 150 / Math.max(1, entries.length)
  const x = (time: number) => Math.max(0, Math.min(1000, ((time - window.start) / span) * 1000))
  entries.forEach((entry, index) => {
    for (const segment of segments(entry, now)) {
      if (segment.end < window.start || segment.start > window.end) continue
      const left = x(segment.start)
      const right = Math.max(left + 0.5, x(segment.end))
      const top = (index * 160) / Math.max(1, entries.length)
      const parts = paths[segment.phase] ?? (paths[segment.phase] = [])
      parts.push(
        `M${left.toFixed(2)},${top.toFixed(2)}H${right.toFixed(2)}V${(top + height).toFixed(2)}H${left.toFixed(2)}Z`,
      )
    }
  })
  return Object.entries(paths).map(([phase, parts]) => ({ phase, path: parts.join("") }))
}

export function mergePages(pages: Page[]) {
  const records = new Map<string, Entry>()
  for (const page of pages) for (const entry of page.entries) records.set(entry.id, entry)
  const order = [...new Set(pages.flatMap((page) => page.messageIDs))].sort()
  const rank = new Map(order.map((id, index) => [id, index]))
  return [...records.values()].sort((a, b) => (rank.get(a.messageID) ?? 0) - (rank.get(b.messageID) ?? 0))
}
