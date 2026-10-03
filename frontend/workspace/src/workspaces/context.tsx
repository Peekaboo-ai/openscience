import { createSimpleContext } from "@synsci/ui/context"
import { createStore, reconcile } from "solid-js/store"
import { batch, createEffect, onCleanup, onMount, untrack } from "solid-js"
import type { Project, Session, SessionStatus } from "@synsci/sdk/v2/client"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { settingsApi } from "@/components/settings/api"
import type { SessionContext } from "@/pages/session-sidebar-action"
import { createConversationCache } from "./conversations"
import { createRemoteConnections } from "./remote-connections"
import { showToast } from "@synsci/ui/toast"
import { serverEvents } from "@/context/server-events"
import { createSessionActivity, type ActivityScope } from "./session-activity"

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
    const activity = createSessionActivity(typeof localStorage === "undefined" ? undefined : localStorage)
    const observed = new Map<string, { unsubscribe: () => void; abort: AbortController }>()
    const scopes = (): ActivityScope[] => [
      ...state.projects
        .filter((project) => !project.time.archived)
        .map((project) => ({ base: props.localUrl, projectID: project.id, directory: project.worktree })),
      ...state.remotes.flatMap((remote) =>
        remote.state === "connected" && remote.projectID && remote.directory
          ? [{ base: remoteBase(remote.id), projectID: remote.projectID, directory: remote.directory }]
          : [],
      ),
    ]
    const initialized = new Set<string>()
    const snapshots = new Map<string, number>()
    const snapshot = async (scope: ActivityScope, signal: AbortSignal) => {
      const id = JSON.stringify([scope.base, scope.projectID])
      const attempt = (snapshots.get(id) ?? 0) + 1
      snapshots.set(id, attempt)
      const revision = activity.revision()
      try {
        const statuses = await settingsApi<Record<string, SessionStatus>>(
          scope.base,
          platform.fetch ?? fetch,
          "/session/status",
          { headers: { "x-openscience-project": scope.projectID }, signal },
        )
        // 重连可能与初次读取重叠；先发出的旧请求不能覆盖重连后的快照。
        if (!signal.aborted && snapshots.get(id) === attempt) activity.snapshot(scope, statuses, revision)
      } catch (error) {
        // 网络故障不能当作任务结束；保留上次状态，重连后再用有效快照校准。
        if (!signal.aborted && snapshots.get(id) === attempt) {
          initialized.delete(id)
          console.warn("Could not refresh conversation activity", error)
        }
      }
    }
    createEffect(() => {
      const current = scopes()
      const bases = new Set([props.localUrl, ...current.map((scope) => scope.base)])
      untrack(() => {
        for (const [base, observer] of observed) {
          if (bases.has(base)) continue
          observer.unsubscribe()
          observer.abort.abort()
          observed.delete(base)
          for (const id of initialized) if (JSON.parse(id)[0] === base) initialized.delete(id)
        }
        for (const base of bases) {
          if (observed.has(base)) continue
          const controller = new AbortController()
          const unsubscribe = serverEvents.subscribe(base, platform.fetch ?? fetch, (event) => {
            activity.event(base, event)
            if (event.payload.type !== "server.connected") return
            for (const scope of scopes()) if (scope.base === base) void snapshot(scope, controller.signal)
          })
          observed.set(base, { unsubscribe, abort: controller })
        }
        for (const scope of current) {
          const id = JSON.stringify([scope.base, scope.projectID])
          if (initialized.has(id)) continue
          initialized.add(id)
          void snapshot(scope, observed.get(scope.base)!.abort.signal)
        }
      })
    })
    onCleanup(() => {
      for (const observer of observed.values()) {
        observer.unsubscribe()
        observer.abort.abort()
      }
    })
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
    const connections = createRemoteConnections({
      read: () => state.remotes,
      write: (remotes) => setState("remotes", reconcile(remotes)),
      request: (id, action) =>
        api<RemoteWorkspace | void>(`/remote-workspaces/${encodeURIComponent(id)}/${action}`, {
          method: "POST",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        }).then((result) => (action === "connect" ? result : undefined)),
      settled: (remote) =>
        showToast({
          variant: remote.state === "connected" ? "success" : "error",
          title: remote.state === "connected" ? `${remote.name} connected` : `${remote.name} connection failed`,
          description:
            remote.state === "connected"
              ? "Ready to open from Projects."
              : "View connection details in Projects, then retry.",
        }),
    })
    onCleanup(() => connections.dispose())
    function refresh(fresh = true): Promise<void> {
      // 写操作后的刷新必须晚于已在途的读取，避免旧快照覆盖刚完成的连接。
      if (pending) return fresh ? pending.then(() => refresh(false)) : pending
      pending = reload().finally(() => {
        pending = undefined
      })
      return pending
    }
    async function reload() {
      const revision = connections.revision()
      try {
        const value = await api<Catalog>("/workspace/catalog")
        if (abort.signal.aborted) return
        batch(() => {
          setState("projects", reconcile(value.projects))
          connections.sync(value.remotes, revision)
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
      await connections.connect(id)
      await refresh()
    }
    async function disconnect(id: string) {
      await connections.disconnect(id)
      await refresh()
    }
    async function remove(id: string) {
      await connections.disconnect(id)
      await api(`/remote-workspaces/${id}`, { method: "DELETE" })
      connections.forget(id)
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
      activity,
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
