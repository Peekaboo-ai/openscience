import { createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import type { MemoryStore, MemoryNote, MemoryScope, MemoryCategory, MemoryPreview, MemoryCatalog } from "@synsci/sdk/v2"
import { SettingsApiError, settingsApi } from "./api"
import { memoryProjects, type MemoryWorkspaces } from "./memory-workspaces"

export type { MemoryStore, MemoryNote, MemoryScope, MemoryCategory, MemoryPreview, MemoryCatalog }
export type MemoryServices = {
  sdk: { readonly url: string }
  platform: { fetch?: typeof fetch }
  label?: string
  pathname?: string
  workspaces?: MemoryWorkspaces
}
export type MemoryEditor =
  { kind: "note"; note?: MemoryNote; scope: MemoryScope } | { kind: "category"; category?: MemoryCategory }
export type MemoryDraft = {
  title: string
  content: string
  categoryID: string
  scope: MemoryScope
  enabled: boolean
  expires: string
  error: string
  revision: number
}
const draftKey = (draft: MemoryDraft) =>
  JSON.stringify({
    title: draft.title,
    content: draft.content,
    categoryID: draft.categoryID,
    scope: draft.scope,
    enabled: draft.enabled,
    expires: draft.expires,
  })
const dateValue = (value?: number | null) => {
  if (!value) return ""
  const date = new Date(value)
  return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
export type MemoryConfirmation = { message: string; revision: number; ids?: string[]; categoryID?: string }
export const scopeKey = (scope: MemoryScope) =>
  scope.kind === "global"
    ? "global"
    : scope.kind === "project"
      ? `project:${scope.projectID}`
      : `session:${scope.projectID}:${scope.sessionID}`
export const omissionLabel: Record<MemoryPreview["omitted"][number]["reason"], string> = {
  "memory-off": "Memory is paused",
  "note-off": "Note is paused",
  "category-off": "Auto-recall is off",
  expired: "Expired",
  overridden: "Replaced by a more specific note",
  budget: "Context limit reached",
}

export function createMemoryState(services: MemoryServices) {
  const route = services.pathname?.match(/^\/([^/]+)\/session(?:\/(ses_[^/]+))?/)
  const initial = { projectID: route?.[1] ?? "", sessionID: route?.[2] ?? "" }
  const selected = services.workspaces?.state.selected
  const initialRemote =
    selected && services.workspaces?.remoteBase(selected) === services.sdk.url
      ? selected
      : (services.workspaces?.state.remotes.find(
          (remote) => services.workspaces!.remoteBase(remote.id) === services.sdk.url,
        )?.id ?? "")
  const [state, setState] = createStore<{
    data?: MemoryStore
    catalog: MemoryCatalog
    preview?: MemoryPreview
    scope: MemoryScope["kind"] | "all"
    projectID: string
    sessionID: string
    remoteID: string
    category: string
    query: string
    inherited: boolean
    loading: boolean
    catalogLoading: boolean
    previewLoading: boolean
    writing: boolean
    error?: string
    catalogError?: string
    previewError?: string
    mutationError?: string
    notice?: string
    connectionError?: string
    editor?: MemoryEditor
    editorOpen: boolean
    editorVersion: number
    draft?: MemoryDraft
    confirmation?: MemoryConfirmation
    refresh: number
    epoch: number
  }>({
    catalog: { projects: [], sessions: [] },
    scope: initial.sessionID ? "session" : initial.projectID ? "project" : "global",
    ...initial,
    remoteID: initialRemote,
    category: "all",
    query: "",
    inherited: true,
    loading: true,
    catalogLoading: true,
    previewLoading: false,
    writing: false,
    editorOpen: false,
    editorVersion: 0,
    refresh: 0,
    epoch: 0,
  })
  const controllers = new Map<string, AbortController>()
  let disposed = false
  let base = ""
  let reachable = false
  let previewTarget = ""
  let generation = 0
  let draftBaseline = ""
  const drafts = new Map<string, { editor: MemoryEditor; draft: MemoryDraft; editorOpen: boolean; baseline: string }>()
  const remote = () => services.workspaces?.state.remotes.find((item) => item.id === state.remoteID)
  const available = () => !state.remoteID || remote()?.state === "connected"
  const url = () =>
    services.workspaces
      ? state.remoteID
        ? services.workspaces.remoteBase(state.remoteID)
        : services.workspaces.localUrl
      : services.sdk.url
  const draftDirty = () => !!state.draft && draftKey(state.draft) !== draftBaseline
  const closeEditor = () => {
    draftBaseline = ""
    drafts.delete(url())
    setState({ editor: undefined, draft: undefined, editorOpen: false, mutationError: undefined })
  }
  const openEditor = (editor: MemoryEditor) => {
    const note = editor.kind === "note" ? editor.note : undefined
    const category = editor.kind === "category" ? editor.category : undefined
    const draft: MemoryDraft = {
      title: note?.title ?? category?.name ?? "",
      content: note?.content ?? category?.description ?? "",
      categoryID: note?.categoryID ?? (state.category === "all" ? "about-you" : state.category),
      scope: editor.kind === "note" ? structuredClone(unwrap(editor.scope)) : { kind: "global" },
      enabled: note?.enabled ?? category?.autoRecall ?? true,
      expires: dateValue(note?.expiresAt),
      error: "",
      revision: state.data?.revision ?? 0,
    }
    draftBaseline = draftKey(draft)
    // 编辑器与草稿由面板持有，切换分类或短暂断线不会销毁输入；替换联合类型时清除旧字段。
    setState("editor", reconcile(structuredClone(unwrap(editor))))
    setState("draft", reconcile(draft))
    // reconcile 可能复用编辑器对象；独立版本确保替换编辑目标后表单重新绑定正确的记录。
    setState("editorVersion", (value) => value + 1)
    setState({ editorOpen: true, mutationError: undefined, notice: undefined, confirmation: undefined })
  }
  const suspendEditor = () => {
    if (draftDirty()) setState("editorOpen", false)
    else closeEditor()
  }
  const resumeEditor = () => {
    if (state.editor && state.draft) setState("editorOpen", true)
  }
  const projects = createMemo(() =>
    memoryProjects(services.workspaces ? { projects: [], sessions: [] } : state.catalog, services.workspaces),
  )
  const projectValue = () => (state.remoteID ? `remote:${state.remoteID}` : state.projectID)
  const selectProject = (value: string) => {
    const project = projects().find((item) => item.value === value)
    setState({
      remoteID: project?.remoteID ?? "",
      projectID: project?.projectID ?? "",
      sessionID: "",
      notice: undefined,
      connectionError: undefined,
    })
  }
  const selectServer = (remoteID: string) =>
    setState({
      remoteID,
      projectID: services.workspaces?.state.remotes.find((item) => item.id === remoteID)?.projectID ?? "",
      sessionID: "",
      connectionError: undefined,
    })
  const connect = async () => {
    const id = state.remoteID
    if (!id || !services.workspaces) return
    setState("connectionError", undefined)
    await services.workspaces.connect(id).catch((error: unknown) => {
      if (!disposed && state.remoteID === id)
        setState("connectionError", error instanceof Error ? error.message : "Could not connect. Please retry.")
    })
  }
  createEffect(() => {
    if (!services.workspaces?.state.ready) return
    const projectID = state.remoteID
      ? (remote()?.projectID ?? "")
      : (services.workspaces.state.projects.find((project) => project.id === state.projectID && !project.time.archived)
          ?.id ?? "")
    if (projectID !== state.projectID) setState({ projectID, sessionID: "" })
  })
  const request = async <T>(
    key: string,
    path: string,
    accept: (data: T) => void,
    fail: (message: string) => void,
    done: () => void,
  ) => {
    controllers.get(key)?.abort()
    const controller = new AbortController()
    controllers.set(key, controller)
    const target = url()
    await settingsApi<T>(
      target,
      services.platform.fetch ?? fetch,
      `/settings/memory${path}`,
      { signal: controller.signal },
      20_000,
    )
      .then((data) => {
        if (!disposed && !controller.signal.aborted && target === url() && available()) accept(data)
      })
      .catch((error: unknown) => {
        if (disposed || controller.signal.aborted || target !== url() || !available()) return
        fail(
          error instanceof SettingsApiError && error.status === 404 && key === "store"
            ? "Memory is unavailable on this server. Update its backend, then retry."
            : error instanceof Error
              ? error.message
              : "Could not load memory. Check the connection and retry.",
        )
      })
      .finally(() => {
        if (!disposed && !controller.signal.aborted && target === url() && available()) done()
      })
  }
  const load = () => {
    if (!available()) return
    setState({ loading: true, error: undefined })
    return request<MemoryStore>(
      "store",
      "",
      (data) => {
        if (state.data && data.revision < state.data.revision) return
        setState("data", reconcile(data))
        if (state.category !== "all" && !data.categories.some((x) => x.id === state.category))
          setState("category", "all")
      },
      (error) => setState("error", error),
      () => setState("loading", false),
    )
  }
  const selectedScope = (): MemoryScope | undefined => {
    if (!available()) return
    if (state.scope === "global") return { kind: "global" }
    if (!state.projectID || state.scope === "all") return
    if (
      services.workspaces &&
      !state.catalogLoading &&
      !state.catalog.projects.some((project) => project.id === state.projectID)
    )
      return
    if (state.scope === "project") return { kind: "project", projectID: state.projectID }
    if (state.sessionID) return { kind: "session", projectID: state.projectID, sessionID: state.sessionID }
  }
  const scopeLabel = (scope: MemoryScope) => {
    if (scope.kind === "global") return "Global"
    const project =
      projects().find((x) => x.projectID === scope.projectID && x.remoteID === state.remoteID)?.name ??
      state.catalog.projects.find((x) => x.id === scope.projectID)?.name ??
      scope.projectID
    if (scope.kind === "project") return project
    return state.catalog.sessions.find((x) => x.id === scope.sessionID)?.title ?? scope.sessionID
  }
  createEffect(() => {
    const target = url()
    const connected = available()
    if (base === target && reachable === connected) return
    const changed = base !== target
    if (changed) {
      // 草稿按后端隔离，切回原服务器时恢复；只在当前面板生命周期内保存，限制数量避免长期占用内存。
      untrack(() => {
        if (base) {
          drafts.delete(base)
          if (state.editor && state.draft) {
            drafts.set(base, {
              editor: structuredClone(unwrap(state.editor)),
              draft: structuredClone(unwrap(state.draft)),
              editorOpen: state.editorOpen,
              baseline: draftBaseline,
            })
            while (drafts.size > 8) drafts.delete(drafts.keys().next().value!)
          }
        }
        const cached = drafts.get(target)
        draftBaseline = cached?.baseline ?? ""
        setState("editor", reconcile(cached?.editor))
        setState("draft", reconcile(cached?.draft))
        setState("editorOpen", cached?.editorOpen ?? false)
      })
    }
    base = target
    reachable = connected
    generation++
    controllers.forEach((x) => x.abort())
    // 后端数据不得跨服务器展示；同一服务器重新连接时保留独立草稿。
    setState({
      data: undefined,
      preview: undefined,
      catalog: { projects: [], sessions: [] },
      confirmation: undefined,
      mutationError: undefined,
      notice: undefined,
      writing: false,
      loading: connected,
      catalogLoading: connected,
      previewLoading: false,
      error: undefined,
      catalogError: undefined,
      previewError: undefined,
      connectionError: undefined,
      epoch: generation,
      ...(!services.workspaces ? initial : {}),
      category: "all",
      query: "",
    })
    untrack(load)
  })
  createEffect(() => {
    url()
    // 切换源的清理可能晚于选择事件触发的读取；代次变化保证取消后重新加载。
    state.epoch
    state.refresh
    const projectID = state.projectID
    if (!available()) return
    controllers.get("catalog-fallback")?.abort()
    setState({ catalogLoading: true, catalogError: undefined })
    void request<MemoryCatalog>(
      "catalog",
      `/catalog${projectID ? `?projectID=${encodeURIComponent(projectID)}` : ""}`,
      (data) => {
        setState("catalog", reconcile(data))
        if (projectID && !data.projects.some((x) => x.id === projectID)) {
          if (services.workspaces)
            setState({
              sessionID: "",
              catalogError: "This project is unavailable on its server. Refresh or choose another project.",
            })
          else setState({ projectID: "", sessionID: "", scope: "global" })
        }
        if (state.sessionID && !data.sessions.some((x) => x.id === state.sessionID)) setState("sessionID", "")
      },
      (error) => {
        setState("catalogError", error)
        // 上一个后端的路由可能仍在地址栏；先恢复项目选择器，不能把用户困在无效作用域。
        if (projectID)
          void request<MemoryCatalog>(
            "catalog-fallback",
            "/catalog",
            (data) => {
              if (state.projectID !== projectID) return
              setState("catalog", reconcile(data))
              if (!services.workspaces && !data.projects.some((x) => x.id === projectID))
                setState({ projectID: "", sessionID: "", scope: "global", catalogError: undefined })
            },
            (message) => setState("catalogError", message),
            () => setState("catalogLoading", false),
          )
      },
      () => setState("catalogLoading", false),
    )
  })
  createEffect(() => {
    url()
    state.epoch
    state.refresh
    const revision = state.data?.revision
    const scope = selectedScope()
    controllers.get("preview")?.abort()
    const key = `${url()}:${scope ? scopeKey(scope) : "none"}`
    if (key !== previewTarget) {
      previewTarget = key
      setState("preview", undefined)
    }
    setState({ previewError: undefined, previewLoading: false })
    if (revision === undefined || !scope) return
    const query = new URLSearchParams()
    if (scope.kind !== "global") query.set("projectID", scope.projectID)
    if (scope.kind === "session") query.set("sessionID", scope.sessionID)
    setState("previewLoading", true)
    void request<MemoryPreview>(
      "preview",
      `/preview?${query}`,
      (preview) => setState("preview", reconcile(preview)),
      (error) => setState("previewError", error),
      () => setState("previewLoading", false),
    )
  })
  onCleanup(() => {
    disposed = true
    controllers.forEach((x) => x.abort())
  })
  const refresh = () => {
    void services.workspaces?.refresh()
    void load()
    setState("refresh", (x) => x + 1)
  }
  const save = async (path: string, method: string, body: Record<string, unknown>, notice: string) => {
    if (!state.data || state.writing || !available()) return false
    const target = url()
    const epoch = generation
    setState({ writing: true, mutationError: undefined, notice: undefined })
    try {
      const data = await settingsApi<MemoryStore>(
        target,
        services.platform.fetch ?? fetch,
        `/settings/memory${path}`,
        {
          method,
          body: JSON.stringify({ revision: state.data.revision, ...body }),
        },
        30_000,
      )
      if (disposed || epoch !== generation) return false
      if (!state.data || data.revision >= state.data.revision) setState("data", reconcile(data))
      setState({ notice, confirmation: undefined })
      return true
    } catch (error) {
      if (disposed || epoch !== generation) return false
      setState(
        "mutationError",
        error instanceof Error ? error.message : "Could not save. Your draft has been preserved.",
      )
      if (error instanceof SettingsApiError && error.status === 409) {
        await load()
        if (epoch === generation) setState("confirmation", undefined)
      }
      return false
    } finally {
      if (!disposed && epoch === generation) setState("writing", false)
    }
  }
  const inScope = createMemo(() => {
    const scope = selectedScope()
    const inherited = state.inherited
      ? new Set([
          ...(state.preview?.included.map((x) => x.note.id) ?? []),
          ...(state.preview?.omitted.map((x) => x.note.id) ?? []),
        ])
      : new Set<string>()
    return (state.data?.notes ?? []).filter(
      (x) => state.scope === "all" || (!!scope && scopeKey(x.scope) === scopeKey(scope)) || inherited.has(x.id),
    )
  })
  const filtered = createMemo(() => {
    const query = state.query.toLocaleLowerCase().trim()
    return inScope()
      .filter(
        (note) =>
          (state.category === "all" || note.categoryID === state.category) &&
          (!query ||
            `${note.title}\n${note.content}\n${state.data?.categories.find((x) => x.id === note.categoryID)?.name}`
              .toLocaleLowerCase()
              .includes(query)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  })
  const confirm = async () => {
    const selected = state.confirmation
    if (!selected) return
    if (selected.ids)
      await save("/notes/delete", "POST", { ids: selected.ids, revision: selected.revision }, "Memory deleted.")
    else if (selected.categoryID) {
      if (
        await save(`/categories/${selected.categoryID}`, "DELETE", { revision: selected.revision }, "Category deleted.")
      )
        setState("category", "all")
    }
  }
  return {
    state,
    setState,
    selectedScope,
    scopeLabel,
    inScope,
    filtered,
    refresh,
    save,
    confirm,
    projects,
    projectValue,
    selectProject,
    selectServer,
    remote,
    available,
    connect,
    openEditor,
    closeEditor,
    suspendEditor,
    resumeEditor,
    draftDirty,
    source: url,
  }
}

export type MemoryState = ReturnType<typeof createMemoryState>
