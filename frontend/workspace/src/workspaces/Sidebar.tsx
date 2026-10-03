import { For, Show, createEffect, createMemo, onCleanup, onMount, untrack, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation } from "@solidjs/router"
import { createMediaQuery } from "@solid-primitives/media"
import { Button } from "@synsci/ui/button"
import { DropdownMenu } from "@synsci/ui/dropdown-menu"
import { useDialog } from "@synsci/ui/context/dialog"
import { DialogSettings } from "@/components/dialog-settings"
import { settingsApi } from "@/components/settings/api"
import { remoteWorkspaceBlocked } from "./availability"
import { showToast } from "@synsci/ui/toast"
import {
  IconCloud,
  IconFolder,
  IconMessageSquare,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconSearch,
  IconChevronDown,
  IconChevronRight,
  IconMoreH,
  IconX,
} from "@/atlas/shared/Icon"
import { SessionSidebarActions } from "@/pages/session-sidebar-action"
import { uiStore } from "@/atlas/store/ui"
import { BrandMark } from "@/atlas/BrandMark"
import { projectPrefs } from "@/atlas/store/projectPrefs"
import { confirmDialog } from "@/atlas/dialogs"
import { ProjectDialog } from "./ProjectDialog"
import { RemoteProject } from "./RemoteProject"
import { ConversationStatus } from "./ConversationStatus"
import { useWorkspaces, type RemoteWorkspace } from "./context"
import type { Project, Session } from "@synsci/sdk/v2/client"
import "./workspaces.css"

function message(error: unknown) {
  showToast({
    variant: "error",
    title: "Workspace action failed",
    description: error instanceof Error ? error.message : String(error),
  })
}

function Conversations(props: { projectID: string; remoteID?: string; query: string }) {
  const workspaces = useWorkspaces()
  const location = useLocation()
  const dialog = useDialog()
  const [state, setState] = createStore({
    archived: false,
    editing: "",
    title: "",
    limit: 50,
    loadingHint: false,
  })
  const abort = new AbortController()
  const base = () => (props.remoteID ? workspaces.remoteBase(props.remoteID) : workspaces.localUrl)
  const entry = createMemo(() =>
    workspaces.conversations.get({
      base: base(),
      projectID: props.projectID,
      query: props.query,
      limit: state.limit,
    }),
  )
  const listing = () => entry().state
  const api = <T,>(route: string, init?: RequestInit) =>
    settingsApi<T>(base(), workspaces.fetch, route, {
      ...init,
      headers: { "x-openscience-project": props.projectID },
      signal: abort.signal,
    })
  const load = (fresh = false) => entry().load(fresh)
  const refresh = () => {
    workspaces.conversations.invalidate(base(), props.projectID)
    return load(true)
  }
  async function update(session: Session, patch: object) {
    await api(`/session/${session.id}`, { method: "PATCH", body: JSON.stringify(patch) })
    await refresh()
  }
  const visible = () =>
    listing()
      .sessions.filter(
        (session) =>
          !!session.time.archived === state.archived &&
          (!props.query || session.title.toLowerCase().includes(props.query.toLowerCase())),
      )
      .sort((a, b) => (b.time.pinned ?? 0) - (a.time.pinned ?? 0) || b.time.updated - a.time.updated)
  async function remove(session: Session) {
    if (
      !(await confirmDialog(dialog, {
        title: "Delete conversation?",
        message: `“${session.title}” and its messages will be permanently deleted.`,
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return
    await api(`/session/${session.id}`, { method: "DELETE" })
    if (location.pathname.endsWith(`/${session.id}`) && workspaces.state.selected === (props.remoteID ?? ""))
      workspaces.open(props.projectID, undefined, props.remoteID)
    await refresh()
  }
  onMount(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void load()
    }, 5000)
    onCleanup(() => {
      abort.abort()
      clearInterval(timer)
    })
  })
  createEffect(() => {
    const current = entry()
    current.retain()
    setState("loadingHint", false)
    const hint = setTimeout(() => setState("loadingHint", true), 250)
    const timer = setTimeout(() => void current.load(), props.query ? 200 : 0)
    onCleanup(() => {
      clearTimeout(timer)
      clearTimeout(hint)
      current.release()
    })
  })
  return (
    <div class="workspace-conversations" aria-busy={!listing().ready}>
      <Show when={!listing().ready && state.loadingHint}>
        <p class="workspace-hint" role="status">
          Loading conversations…
        </p>
      </Show>
      <Show when={listing().error}>
        <button class="workspace-inline-error" onClick={() => void load(true)}>
          {listing().error} · Retry
        </button>
      </Show>
      <For each={visible()}>
        {(session) => (
          <div
            class="workspace-conversation"
            data-session-id={session.id}
            data-active={
              location.pathname.endsWith(`/${session.id}`) &&
              (workspaces.state.selected || "") === (props.remoteID || "")
            }
          >
            <Show
              when={state.editing !== session.id}
              fallback={
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    void update(session, { title: state.title })
                      .then(() => setState("editing", ""))
                      .catch(message)
                  }}
                >
                  <input
                    autofocus
                    aria-label="Conversation title"
                    value={state.title}
                    onInput={(event) => setState("title", event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setState("editing", "")
                    }}
                  />
                </form>
              }
            >
              <button
                class="workspace-row-main"
                onClick={() => workspaces.open(props.projectID, session.id, props.remoteID)}
                title={session.title}
              >
                <ConversationStatus
                  status={workspaces.activity.get(base(), session.id)?.status}
                  completed={workspaces.activity.get(base(), session.id)?.completed}
                />
                <span>
                  {session.time.pinned ? "· " : ""}
                  {session.title || "New task"}
                </span>
              </button>
              <DropdownMenu>
                <DropdownMenu.Trigger class="workspace-icon-button" aria-label={`Actions for ${session.title}`}>
                  <IconMoreH size={14} />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content>
                    <DropdownMenu.Item onSelect={() => setState({ editing: session.id, title: session.title })}>
                      Rename
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={() =>
                        void update(session, { time: { pinned: session.time.pinned ? 0 : Date.now() } }).catch(message)
                      }
                    >
                      {session.time.pinned ? "Unpin" : "Pin"}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={() =>
                        void update(session, { time: { archived: session.time.archived ? 0 : Date.now() } }).catch(
                          message,
                        )
                      }
                    >
                      {session.time.archived ? "Restore" : "Archive"}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={() => void remove(session).catch(message)}>Delete</DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </Show>
          </div>
        )}
      </For>
      <Show when={listing().ready && !listing().error && !visible().length}>
        <p class="workspace-hint">{props.query ? "No matching conversations" : "No conversations yet"}</p>
      </Show>
      <Show when={state.archived || listing().sessions.some((session) => !!session.time.archived)}>
        <button class="workspace-text-button" onClick={() => setState("archived", !state.archived)}>
          {state.archived ? "Show active" : "Archived conversations"}
        </button>
      </Show>
      <Show when={listing().more}>
        <button
          class="workspace-text-button"
          onClick={() => {
            setState("limit", state.limit + 50)
          }}
        >
          Load more conversations
        </button>
      </Show>
    </div>
  )
}

export function WorkspaceShell(props: ParentProps) {
  const workspaces = useWorkspaces()
  const dialog = useDialog()
  const location = useLocation()
  const narrow = createMediaQuery("(max-width: 760px)")
  createEffect(() => {
    const base = workspaces.state.selected ? workspaces.remoteBase(workspaces.state.selected) : workspaces.localUrl
    const sessionID = location.pathname.match(/\/session\/(ses_[^/]+)$/)?.[1]
    const viewed = () => workspaces.activity.view(base, !document.hidden && document.hasFocus() ? sessionID : undefined)
    untrack(viewed)
    window.addEventListener("focus", viewed)
    window.addEventListener("blur", viewed)
    document.addEventListener("visibilitychange", viewed)
    onCleanup(() => {
      window.removeEventListener("focus", viewed)
      window.removeEventListener("blur", viewed)
      document.removeEventListener("visibilitychange", viewed)
      workspaces.activity.view(base)
    })
  })
  let sidebar: HTMLElement | undefined
  let previousFocus: HTMLElement | undefined
  const [state, setState] = createStore({
    query: "",
    search: false,
    expanded: {} as Record<string, boolean>,
    projects: true,
    tasks: true,
    busy: false,
    archived: false,
  })
  const create = (mode: "local" | "remote") => dialog.show(() => <ProjectDialog mode={mode} />)
  const activeProject = () => location.pathname.split("/")[1]
  const blocked = () =>
    remoteWorkspaceBlocked({
      selected: workspaces.state.selected,
      remote: workspaces.active(),
    })
  const openRemote = (remote: RemoteWorkspace) => {
    if (remote.state === "connected" && remote.projectID) {
      setState("expanded", remote.id, true)
      workspaces.open(remote.projectID, undefined, remote.id)
      return
    }
    if (remote.projectID) {
      if (remote.state !== "connecting") void workspaces.connect(remote.id).catch(message)
      return
    }
    dialog.show(() => <ProjectDialog remote={remote} />)
  }
  async function newTask() {
    if (state.busy) return
    setState("busy", true)
    try {
      await workspaces.newTask()
    } catch (error) {
      message(error)
    } finally {
      setState("busy", false)
    }
  }
  async function archive(project: Project) {
    const archived = !project.time.archived
    await workspaces.api(`/project/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ archived }),
    })
    await workspaces.refresh()
    if (archived && activeProject() === project.id && !workspaces.state.selected) workspaces.open("")
  }
  createEffect(() => {
    const id = activeProject()
    if (id) setState("expanded", workspaces.state.selected || id, true)
  })
  createEffect(() => {
    if (narrow() && workspaces.state.mobileOpen) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      queueMicrotask(() => sidebar?.querySelector<HTMLButtonElement>(".workspace-close-nav")?.focus())
    } else previousFocus?.focus()
  })
  return (
    <div class="workspace-shell atlas-root">
      <button class="workspace-mobile-toggle" aria-label="Open navigation" onClick={() => workspaces.mobile(true)}>
        <IconChevronRight />
      </button>
      <Show when={workspaces.state.mobileOpen}>
        <button class="workspace-nav-backdrop" aria-label="Close navigation" onClick={() => workspaces.mobile(false)} />
      </Show>
      <aside
        ref={sidebar}
        class="workspace-sidebar"
        data-mobile-open={workspaces.state.mobileOpen}
        inert={narrow() && !workspaces.state.mobileOpen}
        aria-label="Projects and tasks"
        onKeyDown={(event) => {
          if (!narrow()) return
          if (event.key === "Escape") workspaces.mobile(false)
          if (event.key !== "Tab") return
          const items = Array.from(
            sidebar?.querySelectorAll<HTMLElement>("button:not(:disabled),input,a[href]") ?? [],
          ).filter((item) => item.getClientRects().length)
          const target = event.shiftKey ? items.at(-1) : items[0]
          if (document.activeElement === (event.shiftKey ? items[0] : items.at(-1))) {
            event.preventDefault()
            target?.focus()
          }
        }}
      >
        <div class="workspace-brand">
          <BrandMark size={20} />
          <strong>OneLab</strong>
          <button
            class="workspace-icon-button workspace-close-nav"
            aria-label="Close navigation"
            onClick={() => workspaces.mobile(false)}
          >
            <IconX />
          </button>
        </div>
        <nav class="workspace-primary" aria-label="Workspace navigation">
          <button class="workspace-row-main" disabled={state.busy} onClick={() => void newTask()}>
            <IconPlus />
            <span>{state.busy ? "Creating…" : "New task"}</span>
          </button>
          <button class="workspace-row-main" onClick={() => setState({ search: !state.search, query: "" })}>
            <IconSearch />
            <span>Search</span>
          </button>
        </nav>
        <Show when={state.search}>
          <input
            class="workspace-search"
            aria-label="Search projects and tasks"
            placeholder="Search projects and tasks"
            value={state.query}
            onInput={(event) => setState("query", event.currentTarget.value)}
          />
        </Show>
        <div class="workspace-sidebar-scroll">
          <section aria-label="Projects">
            <header class="workspace-section-heading">
              <button onClick={() => setState("projects", !state.projects)} aria-expanded={state.projects}>
                {state.projects ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}Projects
              </button>
              <DropdownMenu>
                <DropdownMenu.Trigger class="workspace-icon-button" aria-label="Add project">
                  <IconPlus />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content>
                    <DropdownMenu.Item onSelect={() => create("local")}>
                      <IconFolder />
                      Open folder / New project
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={() => create("remote")}>
                      <IconCloud />
                      Remote connection
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </header>
            <Show when={state.projects}>
              <For
                each={workspaces.state.projects
                  .filter(
                    (project) =>
                      project.id !== workspaces.state.tasksProjectID && !!project.time.archived === state.archived,
                  )
                  .toSorted(
                    (a, b) =>
                      Number(projectPrefs.isFavorite(b.id, b.worktree)) -
                        Number(projectPrefs.isFavorite(a.id, a.worktree)) ||
                      (b.time.activity ?? b.time.created) - (a.time.activity ?? a.time.created),
                  )}
              >
                {(project) => (
                  <div class="workspace-project">
                    <div
                      class="workspace-project-row"
                      data-active={!workspaces.state.selected && activeProject() === project.id}
                    >
                      <button
                        class="workspace-icon-button"
                        aria-label={`Toggle ${project.name}`}
                        aria-expanded={!!state.expanded[project.id]}
                        onClick={() => setState("expanded", project.id, !state.expanded[project.id])}
                      >
                        {state.expanded[project.id] ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                      </button>
                      <button class="workspace-row-main" onClick={() => workspaces.open(project.id)}>
                        <IconFolder />
                        <span>
                          {projectPrefs.isFavorite(project.id, project.worktree) ? "· " : ""}
                          {project.name || "Untitled project"}
                        </span>
                      </button>
                      <button
                        class="workspace-icon-button"
                        aria-label={`New conversation in ${project.name}`}
                        onClick={() => workspaces.open(project.id, "new")}
                      >
                        <IconPlus size={14} />
                      </button>
                    </div>
                    <DropdownMenu>
                      <DropdownMenu.Trigger
                        class="workspace-project-menu workspace-icon-button"
                        aria-label={`Actions for project ${project.name}`}
                      >
                        <IconMoreH size={14} />
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content>
                          <DropdownMenu.Item onSelect={() => projectPrefs.toggleFavorite(project.id, project.worktree)}>
                            {projectPrefs.isFavorite(project.id, project.worktree) ? "Unpin project" : "Pin project"}
                          </DropdownMenu.Item>
                          <DropdownMenu.Item onSelect={() => void archive(project).catch(message)}>
                            {project.time.archived ? "Restore project" : "Archive project"}
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu>
                    <Show when={state.expanded[project.id] || !!state.query}>
                      <Conversations
                        projectID={project.id}
                        query={project.name?.toLowerCase().includes(state.query.toLowerCase()) ? "" : state.query}
                      />
                    </Show>
                  </div>
                )}
              </For>
              <For each={workspaces.state.remotes}>
                {(remote) => (
                  <RemoteProject
                    remote={remote}
                    active={workspaces.state.selected === remote.id}
                    expanded={!!state.expanded[remote.id]}
                    onToggle={() => setState("expanded", remote.id, !state.expanded[remote.id])}
                    onOpen={() => openRemote(remote)}
                    onConnect={() => void workspaces.connect(remote.id).catch(message)}
                    onDisconnect={() => void workspaces.disconnect(remote.id).catch(message)}
                    onRemove={() => void workspaces.remove(remote.id).catch(message)}
                    onNewConversation={() => workspaces.open(remote.projectID!, "new", remote.id)}
                  >
                    <Show
                      when={
                        remote.state === "connected" && remote.projectID && (state.expanded[remote.id] || !!state.query)
                      }
                    >
                      <Conversations projectID={remote.projectID!} remoteID={remote.id} query={state.query} />
                    </Show>
                  </RemoteProject>
                )}
              </For>
              <Show when={workspaces.state.projects.some((project) => !!project.time.archived)}>
                <button class="workspace-text-button" onClick={() => setState("archived", !state.archived)}>
                  {state.archived ? "Show active projects" : "Archived projects"}
                </button>
              </Show>
              <Show
                when={
                  !workspaces.state.projects.some((project) => project.id !== workspaces.state.tasksProjectID) &&
                  !workspaces.state.remotes.length
                }
              >
                <button class="workspace-text-button" onClick={() => create("local")}>
                  Add your first project
                </button>
              </Show>
            </Show>
          </section>
          <section aria-label="Tasks">
            <header class="workspace-section-heading">
              <button aria-expanded={state.tasks} onClick={() => setState("tasks", !state.tasks)}>
                {state.tasks ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}Tasks
              </button>
              <button
                class="workspace-icon-button"
                aria-label="New task"
                disabled={state.busy}
                onClick={() => void newTask()}
              >
                <IconPlus />
              </button>
            </header>
            <Show when={state.tasks && workspaces.state.tasksProjectID}>
              {(id) => <Conversations projectID={id()} query={state.query} />}
            </Show>
          </section>
          <Show when={workspaces.state.error}>
            <p class="workspace-error" role="alert">
              {workspaces.state.error}
            </p>
            <button class="workspace-text-button" onClick={() => void workspaces.refresh()}>
              Retry
            </button>
          </Show>
        </div>
        <Show when={activeProject() && !blocked()}>
          <SessionSidebarActions
            context={uiStore.context()}
            contextOpen={uiStore.open()}
            onContext={(context) => workspaces.openContext(context)}
          />
        </Show>
        <footer class="workspace-sidebar-footer">
          <button class="workspace-row-main" disabled={blocked()} onClick={() => dialog.show(() => <DialogSettings />)}>
            <IconSettings />
            <span>Settings</span>
            <small>{workspaces.state.selected ? "Remote" : "Local"}</small>
          </button>
        </footer>
      </aside>
      <main class="workspace-content" inert={narrow() && workspaces.state.mobileOpen}>
        <Show
          when={!blocked()}
          fallback={
            <div class="workspace-connection-gate">
              <IconCloud size={20} />
              <h2>{workspaces.active()?.name ?? "Remote workspace"}</h2>
              <p role="status">
                {workspaces.active()?.error || workspaces.active()?.progress || "Waiting for connection…"}
              </p>
              <p>Remote conversations are available only while connected.</p>
              <Show when={workspaces.active()?.state === "connecting"}>
                <p>You can switch projects or continue with local tasks while this connects.</p>
              </Show>
              <Button
                disabled={workspaces.active()?.state === "connecting"}
                onClick={() => {
                  const remote = workspaces.active()
                  if (remote) openRemote(remote)
                }}
              >
                {workspaces.active()?.state === "connecting" ? "Connecting…" : "Reconnect"}
              </Button>
              <Show when={workspaces.active()?.state === "connecting"}>
                <Button
                  variant="ghost"
                  onClick={() => void workspaces.disconnect(workspaces.state.selected).catch(message)}
                >
                  Cancel connection
                </Button>
              </Show>
              <Button variant="ghost" onClick={() => workspaces.open("")}>
                Return to local tasks
              </Button>
            </div>
          }
        >
          {props.children}
        </Show>
      </main>
    </div>
  )
}

export function TaskLanding() {
  const workspaces = useWorkspaces()
  const [state, setState] = createStore({ error: "" })
  onMount(() => {
    void workspaces
      .refresh()
      .then(() => {
        const remote = workspaces.active()
        if (remote?.projectID) {
          workspaces.open(remote.projectID, undefined, remote.id)
          return
        }
        if (workspaces.state.selected) return
        void workspaces
          .newTask()
          .catch((error) => setState("error", error instanceof Error ? error.message : "Could not create task"))
      })
      .catch((error) => setState("error", error instanceof Error ? error.message : "Could not open workspace"))
  })
  return (
    <div class="workspace-connection-gate">
      <Show when={state.error} fallback={<p role="status">Opening task…</p>}>
        <p role="alert">{state.error}</p>
        <Button onClick={() => void workspaces.newTask().catch(message)}>Retry</Button>
      </Show>
    </div>
  )
}
