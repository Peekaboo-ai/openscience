import type { Entry, Page } from "./model"

export const entry = (id: string, extra: Partial<Entry> = {}): Entry => ({
  id,
  messageID: id,
  turnID: "msg_turn",
  kind: "inference",
  title: "Python analysis",
  status: "completed",
  owner: "research",
  resources: [],
  artifacts: [],
  startedAt: 1000,
  completedAt: 2000,
  ...extra,
})
export const page = (ids: string[], extra: Partial<Page> = {}): Page => ({
  sessionID: "ses_a",
  status: "idle",
  entries: ids.map((id) => entry(id)),
  messageIDs: ids,
  totalMessages: ids.length,
  first: ids[0] ?? null,
  last: ids.at(-1) ?? null,
  hasEarlier: false,
  hasMore: false,
  generatedAt: 3000,
  ...extra,
})
