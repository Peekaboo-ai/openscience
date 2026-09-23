import { createSimpleContext } from "@synsci/ui/context"
import { createStore, reconcile } from "solid-js/store"
import { batch, onCleanup, onMount } from "solid-js"
import type { Project, Session } from "@synsci/sdk/v2/client"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { settingsApi } from "@/components/settings/api"
import type { SessionContext } from "@/pages/session-sidebar-action"
import { createConversationCache } from "./conversations"

export type RemoteTarget =
  | { kind: "ssh"; host_id: string }
  | { kind: "wsl"; distro: string; user?: string }
  | { kind: "docker"; container: string }
export type RemoteWorkspace = {
  id: string
  name: string
  target: RemoteTarget
  state: "disconnected" | "connecting" | "connected" | "error"
  progress: string
  error?: string
  directory?: string
  projectID?: string
  home?: string
}
export type Catalog = { projects: Project[]; tasksProjectID?: string; remotes: RemoteWorkspace[] }
export type DirectoryListing = {
  directory: string
  workingDirectory?: string
  parent: string
  entries: { name: string; path: string }[]
}

export const { provider: WorkspaceProvider, use: useWorkspaces } = createSimpleContext({
  name: "Workspaces",
  init: (props: { localUrl: string }) => {
    const server = useServer()
    const platform = usePlatform()
    const key = `openscience-active-remote:${props.localUrl}`
    const stored = (() => {
      try {
        return sessionStorage.getItem(key) ?? ""
      } catch {
        return ""
      }
    })()
    const [state, setState] = createStore({
      projects: [] as Project[],
      remotes: [] as RemoteWorkspace[],
      tasksProjectID: undefined as string | undefined,
      selected: stored,
      error: "",
      ready: false,
      mobileOpen: false,
    })
    const abort = new AbortController()
    let pending: Promise<void> | undefined
    let contextAction: ((context: SessionContext) => void) | undefined
    const api = <T,>(route: string, init?: RequestInit) =>
      settingsApi<T>(props.localUrl, platform.fetch ?? fetch, route, { ...init, signal: init?.signal ?? abort.signal })
    const remoteBase = (id: string) => `${props.localUrl}/remote-workspaces/${encodeURIComponent(id)}/api`
    // 缓存随工作台存活，折叠列表或切换后端不会丢失已加载的对话。
    const conversations = createConversationCache((query, signal) =>
      settingsApi<Session[]>(
        query.base,
        platform.fetch ?? fetch,
        `/session?roots=true&limit=${query.limit}${query.query ? `&search=${encodeURIComponent(query.query)}` : ""}`,
        { headers: { "x-openscience-project": query.projectID }, signal },
      ),
    )
    onCleanup(() => conversations.dispose())
    const active = () => state.remotes.find((item) => item.id === state.selected)
    function refresh(fresh = true): Promise<void> {
      // 写操作后的刷新必须晚于已在途的读取，避免旧快照覆盖刚完成的连接。
      if (pending) return fresh ? pending.then(() => refresh(false)) : pending
      pending = reload().finally(() => {
        pending = undefined
      })
      return pending
    }
    async function reload() {
      try {
        const value = await api<Catalog>("/workspace/catalog")
        if (abort.signal.aborted) return
        batch(() => {
          setState("projects", reconcile(value.projects))
          setState("remotes", reconcile(value.remotes))
          setState({ tasksProjectID: value.tasksProjectID, error: "", ready: true })
        })
      } catch (error) {
        if (!abort.signal.aborted)
          setState({ error: error instanceof Error ? error.message : "Could not load workspaces", ready: true })
      }
    }
    function open(projectID: string, sessionID?: string, remoteID = "") {
      if (remoteID && state.remotes.find((item) => item.id === remoteID)?.state !== "connected")
        throw new Error("Connect this remote workspace first")
      setState({ selected: remoteID, mobileOpen: false })
      try {
        if (remoteID) sessionStorage.setItem(key, remoteID)
        else sessionStorage.removeItem(key)
      } catch {}
      const href = projectID
        ? `/${encodeURIComponent(projectID)}/session${sessionID ? `/${encodeURIComponent(sessionID)}` : ""}`
        : "/"
      // 在切换服务前更新 URL；ServerKey 随后重新挂载所有缓存和项目上下文。
      window.history.pushState({ workspaceRemote: remoteID }, "", href)
      const base = remoteID ? remoteBase(remoteID) : props.localUrl
      if (server.url === base) window.dispatchEvent(new PopStateEvent("popstate"))
      else server.setActive(base)
    }
    async function newTask() {
      const session = await api<Session>("/workspace/task", { method: "POST" })
      conversations.invalidate(props.localUrl, session.projectID)
      await refresh()
      open(session.projectID, session.id)
    }
    async function connect(id: string) {
      await api(`/remote-workspaces/${id}/connect`, { method: "POST" })
      await refresh()
    }
    async function disconnect(id: string) {
      await api(`/remote-workspaces/${id}/disconnect`, { method: "POST" })
      await refresh()
    }
    async function remove(id: string) {
      await api(`/remote-workspaces/${id}`, { method: "DELETE" })
      if (state.selected === id) open("")
      await refresh()
    }
    onMount(() => {
      if (stored) server.setActive(remoteBase(stored))
      void refresh()
      const restore = (event: PopStateEvent) => {
        if (typeof event.state?.workspaceRemote !== "string") return
        const remoteID = event.state.workspaceRemote as string
        setState({ selected: remoteID, mobileOpen: false })
        try {
          sessionStorage.setItem(key, remoteID)
        } catch {}
        server.setActive(remoteID ? remoteBase(remoteID) : props.localUrl)
      }
      window.history.replaceState({ ...window.history.state, workspaceRemote: stored }, "")
      window.addEventListener("popstate", restore)
      const timer = setInterval(() => {
        if (!document.hidden) void refresh(false)
      }, 2000)
      onCleanup(() => {
        window.removeEventListener("popstate", restore)
        clearInterval(timer)
        abort.abort()
      })
    })
    return {
      state,
      api,
      refresh,
      active,
      open,
      newTask,
      connect,
      disconnect,
      remove,
      remoteBase,
      conversations,
      localUrl: props.localUrl,
      fetch: platform.fetch ?? fetch,
      mobile: (value: boolean) => setState("mobileOpen", value),
      registerContext(action: (context: SessionContext) => void) {
        contextAction = action
        return () => {
          if (contextAction === action) contextAction = undefined
        }
      },
      openContext(context: SessionContext) {
        contextAction?.(context)
      },
    }
  },
})
