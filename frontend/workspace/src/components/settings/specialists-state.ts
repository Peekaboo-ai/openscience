import { createMemo, onCleanup } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import type { SpecialistCatalog, SpecialistInput, SpecialistProfile, SpecialistSnapshot } from "@synsci/sdk/v2"

export type { SpecialistCatalog, SpecialistInput, SpecialistProfile, SpecialistSnapshot }
export type SpecialistDraft = Required<SpecialistInput>
export type SpecialistServices = {
  request: <T>(path: string, init?: RequestInit) => Promise<T>
  chat: () => Promise<void>
  label: string
  subscribe?: (refresh: () => void) => () => void
}
export function specialistDraft(profile?: SpecialistInput): SpecialistDraft {
  return {
    name: profile?.name ?? "",
    displayName: profile?.displayName ?? "",
    description: profile?.description ?? "",
    instructions: profile?.instructions ?? "",
    icon: profile?.icon ?? "brain",
    color: profile?.color ?? "neutral",
    enabled: profile?.enabled ?? true,
    skillNames: profile?.skillNames ?? null,
    connectors: profile?.connectors ?? null,
  }
}
export function specialistID(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64)
}
export function createSpecialistsState(services: SpecialistServices) {
  const [state, setState] = createStore<{
    data?: SpecialistSnapshot
    catalog?: SpecialistCatalog
    loading: boolean
    catalogLoading: boolean
    writing: boolean
    error: string
    catalogError: string
    mutationError: string
    notice: string
    query: string
    filter: string
    editor?: {
      name?: string
      source?: SpecialistProfile["source"]
      revision: number
      draft: SpecialistDraft
      baseline: string
      idEdited: boolean
    }
    picker?: "skillNames" | "connectors"
    pickerQuery: string
    conflict: boolean
  }>({
    loading: true,
    catalogLoading: false,
    writing: false,
    error: "",
    catalogError: "",
    mutationError: "",
    notice: "",
    query: "",
    filter: "all",
    pickerQuery: "",
    conflict: false,
  })
  const abort = new AbortController()
  let read = 0
  onCleanup(() => abort.abort())
  const request = <T>(path: string, init?: RequestInit) =>
    services.request<T>(`/settings/specialists${path}`, { ...init, signal: abort.signal })
  const error = (value: unknown) =>
    value instanceof Error ? value.message : "Specialists could not be loaded. Please retry."
  const load = async () => {
    const current = ++read
    setState({ loading: true, error: "" })
    try {
      const data = await request<SpecialistSnapshot>("")
      if (!abort.signal.aborted && current === read) setState("data", reconcile(data))
    } catch (e) {
      if (!abort.signal.aborted && current === read) setState("error", error(e))
    } finally {
      if (!abort.signal.aborted && current === read) setState("loading", false)
    }
  }
  const catalog = async () => {
    if (state.catalogLoading) return
    setState({ catalogLoading: true, catalogError: "" })
    try {
      const data = await request<SpecialistCatalog>("/catalog")
      if (!abort.signal.aborted) setState("catalog", reconcile(data))
    } catch (e) {
      if (!abort.signal.aborted) setState("catalogError", error(e))
    } finally {
      if (!abort.signal.aborted) setState("catalogLoading", false)
    }
  }
  const edit = (profile?: SpecialistProfile, duplicate = false) => {
    const draft = specialistDraft(profile)
    if (duplicate) {
      draft.name = ""
      draft.displayName = `${draft.displayName} copy`
      draft.name = specialistID(draft.displayName)
    }
    setState({
      editor: {
        name: duplicate ? undefined : profile?.name,
        source: duplicate ? undefined : profile?.source,
        revision: state.data?.revision ?? 0,
        draft,
        baseline: JSON.stringify(draft),
        idEdited: !duplicate && !!profile,
      },
      picker: undefined,
      mutationError: "",
      conflict: false,
      notice: "",
    })
    void catalog()
  }
  const dirty = () => !!state.editor && JSON.stringify(unwrap(state.editor.draft)) !== state.editor.baseline
  const close = () => setState({ editor: undefined, picker: undefined, mutationError: "", conflict: false })
  const mutate = async (path: string, method: string, body: object, notice: string) => {
    if (state.writing) return false
    ++read
    setState({ writing: true, loading: false, mutationError: "", notice: "", conflict: false })
    try {
      const data = await request<SpecialistSnapshot>(path, { method, body: JSON.stringify(body) })
      if (abort.signal.aborted) return false
      setState("data", reconcile(data))
      setState("notice", notice)
      return true
    } catch (e) {
      if (!abort.signal.aborted)
        setState({
          mutationError: error(e),
          conflict: !!e && typeof e === "object" && "status" in e && e.status === 409,
        })
      return false
    } finally {
      if (!abort.signal.aborted) setState("writing", false)
    }
  }
  const save = async () => {
    const editor = state.editor
    if (!editor || state.writing) return
    const draft = { ...unwrap(editor.draft), displayName: editor.draft.displayName.trim() }
    const invalid = !draft.displayName
      ? "Enter a name for this specialist."
      : !/^[a-z][a-z0-9_-]{0,63}$/.test(draft.name)
        ? "Agent ID must start with a lowercase letter and contain only letters, numbers, hyphens or underscores (up to 64 characters)."
        : draft.displayName.length > 100
          ? "The name must be 100 characters or fewer."
          : draft.description.length > 2000
            ? "The description must be 2,000 characters or fewer."
            : draft.instructions.length > 32000
              ? "Instructions must be 32,000 characters or fewer."
              : ""
    if (invalid) {
      setState("mutationError", invalid)
      return
    }
    if (
      await mutate(
        editor.name ? `/${encodeURIComponent(editor.name)}` : "",
        editor.name ? "PUT" : "POST",
        { revision: editor.revision, profile: draft },
        `${draft.displayName} saved.`,
      )
    )
      close()
  }
  const filtered = createMemo(() =>
    (state.data?.profiles ?? []).filter(
      (profile) =>
        (state.filter === "all" ||
          state.filter === profile.source ||
          (state.filter === "enabled"
            ? profile.enabled !== false
            : state.filter === "disabled" && profile.enabled === false)) &&
        `${profile.displayName} ${profile.name} ${profile.description}`
          .toLowerCase()
          .includes(state.query.trim().toLowerCase()),
    ),
  )
  return {
    state,
    setState,
    load,
    catalog,
    edit,
    close,
    dirty,
    save,
    filtered,
    async reloadDraft() {
      const name = state.editor?.name
      await load()
      if (state.error) return
      const latest = state.data?.profiles.find((x) => x.name === name)
      if (latest) edit(latest)
      else close()
    },
    toggle: (profile: SpecialistProfile) =>
      mutate(
        `/${encodeURIComponent(profile.name)}`,
        "PATCH",
        { revision: state.data!.revision, enabled: profile.enabled === false },
        `${profile.displayName} ${profile.enabled === false ? "enabled" : "disabled"}.`,
      ),
    remove: (profile: SpecialistProfile) =>
      mutate(
        `/${encodeURIComponent(profile.name)}`,
        "DELETE",
        { revision: state.data!.revision },
        `${profile.displayName} ${profile.source === "builtin" ? "restored to defaults" : "deleted"}.`,
      ),
    async chat() {
      if (state.writing) return
      setState({ writing: true, mutationError: "" })
      try {
        await services.chat()
      } catch (e) {
        if (!abort.signal.aborted) setState("mutationError", error(e))
      } finally {
        if (!abort.signal.aborted) setState("writing", false)
      }
    },
  }
}
export type SpecialistsState = ReturnType<typeof createSpecialistsState>
