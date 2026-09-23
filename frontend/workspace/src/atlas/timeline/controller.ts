import type { ActionTimelinePage, TimelineWorkbench } from "@synsci/sdk/v2/client"
import { mergePages } from "./model"

export type Transport = (
  path: string,
  init?: RequestInit,
  query?: Record<string, string | number | boolean | undefined>,
) => Promise<Response>
export type Snapshot = {
  pages: ActionTimelinePage[]
  entries: ActionTimelinePage["entries"]
  workbench?: TimelineWorkbench
  loading: boolean
  error: string
  workbenchError: string
  updatedAt?: number
}

export async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error("The server did not return JSON. Update or reconnect to the OpenScience server.")
  return response.json() as Promise<T>
}

/** 一个实例只拥有一个会话，卸载后即使旧请求完成也不能再发布结果。 */
export function createTimelineController(sessionID: string, request: Transport, publish: (state: Snapshot) => void) {
  const abort = new AbortController()
  const state: Snapshot = { pages: [], entries: [], loading: false, error: "", workbenchError: "" }
  const base = `/session/${encodeURIComponent(sessionID)}/action-timeline`
  let busy = false
  let pending = false
  let workbenchAt = 0
  let workbenchPending: Promise<void> | undefined
  const emit = () => {
    if (!abort.signal.aborted) publish({ ...state })
  }
  const init = () => ({ signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) })
  const page = async (before?: string) => {
    const value = await json<ActionTimelinePage>(await request(base, init(), { before, limit: 50 }))
    if (value.sessionID !== sessionID || !Array.isArray(value.entries) || !Array.isArray(value.messageIDs))
      throw new Error("Timeline response does not match this session.")
    return value
  }
  const loadWorkbench = async () => {
    try {
      const value = await json<TimelineWorkbench>(await request(`${base}/workbench`, init()))
      if (value.sessionID !== sessionID) throw new Error("Workbench response does not match this session.")
      state.workbench = value
      state.workbenchError = ""
      workbenchAt = Date.now()
    } catch (error) {
      state.workbenchError = error instanceof Error ? error.message : String(error)
    } finally {
      emit()
    }
  }
  const workbench = () => {
    if (!workbenchPending)
      workbenchPending = loadWorkbench().finally(() => {
        workbenchPending = undefined
      })
    return workbenchPending
  }
  async function refresh(force = false) {
    if (abort.signal.aborted) return
    if (busy) {
      pending = true
      return
    }
    busy = true
    state.loading = state.updatedAt === undefined
    emit()
    try {
      const oldest = state.pages.at(-1)?.first
      const next = [await page()]
      // 刷新整个已加载窗口：既补齐突发新增页，也移除撤销/删除后的旧记录。
      while (oldest && next.at(-1)!.hasEarlier && next.at(-1)!.first! > oldest) {
        const prior = next.at(-1)!.first!
        const value = await page(prior)
        if (value.first !== null && value.first >= prior) throw new Error("Timeline cursor did not advance.")
        next.push(value)
      }
      state.pages = next
      state.entries = mergePages(next)
      state.error = ""
      state.updatedAt = Date.now()
      // 行动列表先显示；工作台汇总独立刷新，慢请求不阻塞下一批行动。
      if (force || Date.now() - workbenchAt > 15_000) void workbench()
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    } finally {
      busy = false
      state.loading = false
      emit()
      if (pending && !abort.signal.aborted) {
        pending = false
        void refresh()
      }
    }
  }
  async function earlier() {
    const oldest = state.pages.at(-1)
    if (busy || abort.signal.aborted || !oldest?.hasEarlier || !oldest.first) return
    busy = true
    state.loading = true
    emit()
    try {
      const value = await page(oldest.first)
      if (value.first !== null && value.first >= oldest.first) throw new Error("Timeline cursor did not advance.")
      state.pages = [...state.pages, value]
      state.entries = mergePages(state.pages)
      state.error = ""
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    } finally {
      busy = false
      state.loading = false
      emit()
      if (pending && !abort.signal.aborted) {
        pending = false
        void refresh()
      }
    }
  }
  return { refresh, earlier, dispose: () => abort.abort() }
}
