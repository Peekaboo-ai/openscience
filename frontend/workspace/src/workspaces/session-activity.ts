import { createStore } from "solid-js/store"
import type { GlobalEvent, SessionStatus } from "@synsci/sdk/v2/client"

type Activity = {
  directory: string
  status: SessionStatus["type"]
  completed?: number
  failed?: boolean
  revision: number
}
export type ActivityScope = { base: string; projectID: string; directory: string }
const key = (base: string, sessionID: string) => JSON.stringify([base, sessionID])
const directoryKey = (directory: string) => {
  const normalized = directory.replaceAll("\\", "/").replace(/\/$/, "")
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized
}

export function createSessionActivity(storage?: Pick<Storage, "getItem" | "setItem">) {
  const storageKey = "onelab-session-completions-v1"
  const [state, setState] = createStore<Record<string, Activity>>({})
  let revision = 0
  let viewed: string | undefined
  if (storage) {
    try {
      const saved: unknown = JSON.parse(storage.getItem(storageKey) ?? "{}")
      if (saved && typeof saved === "object") {
        for (const [id, completed] of Object.entries(saved)) {
          if (typeof completed === "number" && completed > Date.now() - 30 * 86400_000)
            setState(id, { directory: "", status: "idle", completed, revision: 0 })
        }
      }
    } catch (error) {
      console.warn("Could not restore session completion indicators", error)
    }
  }
  const persist = () => {
    if (!storage) return
    try {
      storage.setItem(
        storageKey,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(state)
              .filter(([, activity]) => activity.completed)
              .sort((a, b) => b[1].completed! - a[1].completed!)
              .slice(0, 500)
              .map(([id, activity]) => [id, activity.completed]),
          ),
        ),
      )
    } catch (error) {
      console.warn("Could not save session completion indicators", error)
    }
  }
  const status = (base: string, directory: string, sessionID: string, value: SessionStatus["type"]) => {
    const id = key(base, sessionID)
    const previous = state[id]
    const previousCompleted = previous?.completed
    // 初始空闲快照不代表新完成；只有观察到运行→空闲才产生未读提示。
    const completed =
      value !== "idle"
        ? undefined
        : previous && previous.status !== "idle"
          ? !previous.failed && viewed !== id
            ? Date.now()
            : undefined
          : previous?.completed
    setState(id, {
      directory,
      status: value,
      completed,
      failed: value === "idle" ? previous?.failed : false,
      revision: ++revision,
    })
    if (completed !== previousCompleted) persist()
  }
  return {
    get(base: string, sessionID: string) {
      return state[key(base, sessionID)]
    },
    view(base: string, sessionID?: string) {
      viewed = sessionID ? key(base, sessionID) : undefined
      if (!viewed || !state[viewed]?.completed) return
      setState(viewed, "completed", undefined)
      persist()
    },
    revision: () => revision,
    snapshot(scope: ActivityScope, statuses: Record<string, SessionStatus>, started: number) {
      const ids = new Set(Object.keys(statuses))
      for (const [id, activity] of Object.entries(state)) {
        const [base, sessionID] = JSON.parse(id) as [string, string]
        if (base === scope.base && directoryKey(activity.directory) === directoryKey(scope.directory))
          ids.add(sessionID)
      }
      for (const sessionID of ids) {
        // 读取期间收到的实时事件更鲜；迟到的 HTTP 快照不能把新任务改回空闲。
        if ((state[key(scope.base, sessionID)]?.revision ?? 0) > started) continue
        status(scope.base, scope.directory, sessionID, statuses[sessionID]?.type ?? "idle")
      }
    },
    event(base: string, event: GlobalEvent) {
      const payload = event.payload
      if (payload.type === "session.status")
        status(base, event.directory, payload.properties.sessionID, payload.properties.status.type)
      if (payload.type === "session.idle") status(base, event.directory, payload.properties.sessionID, "idle")
      if (payload.type === "session.error" && payload.properties.sessionID) {
        const id = key(base, payload.properties.sessionID)
        setState(id, {
          directory: event.directory,
          status: "idle",
          failed: true,
          completed: undefined,
          revision: ++revision,
        })
        persist()
      }
      if (payload.type === "session.deleted") {
        setState(key(base, payload.properties.info.id), undefined!)
        persist()
      }
      if (payload.type === "global.disposed" || payload.type === "server.instance.disposed") {
        for (const id of Object.keys(state)) {
          if ((JSON.parse(id) as string[])[0] !== base) continue
          if (payload.type === "server.instance.disposed" && state[id].directory !== event.directory) continue
          setState(id, { status: "idle", revision: ++revision })
        }
      }
    },
  }
}
