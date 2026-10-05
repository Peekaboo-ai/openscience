import { For, Index, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation } from "@solidjs/router"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { Switch } from "@synsci/ui/switch"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useWorkspaces } from "@/workspaces/context"
import { FormButton, PanelBody, PanelHeader, PanelScroll, SearchInput } from "./_shared"
import { MemoryEditor } from "./MemoryEditor"
import {
  createMemoryState,
  omissionLabel,
  scopeKey,
  type MemoryServices,
  type MemoryNote,
  type MemoryEditor as Editor,
} from "./memory-state"
import "./memory.css"

export function Memory(props: { services?: MemoryServices } = {}) {
  const sdk = props.services?.sdk ?? useGlobalSDK()
  const platform = props.services?.platform ?? usePlatform()
  const server = props.services ? undefined : useServer()
  const location = props.services ? undefined : useLocation()
  const workspaces = props.services ? props.services.workspaces : useWorkspaces()
  const memory = createMemoryState({
    sdk,
    platform,
    workspaces,
    pathname: props.services?.pathname ?? location?.pathname,
  })
  const state = memory.state
  const [navigation, setNavigation] = createStore<{ replacement?: Editor }>({})
  const locked = () => state.writing || !!state.confirmation || !!navigation.replacement
  createEffect(() => {
    state.epoch
    setNavigation("replacement", undefined)
  })
  const browse = (action: () => void) => {
    if (locked()) return
    memory.suspendEditor()
    action()
  }
  const openEditor = (editor: Editor) => {
    if (locked()) return
    if (memory.draftDirty()) setNavigation("replacement", editor)
    else memory.openEditor(editor)
  }
  const label = () =>
    workspaces
      ? state.remoteID
        ? (memory.remote()?.name ?? "Remote project")
        : "Local"
      : (props.services?.label ?? server?.name ?? sdk.url)
  const category = () => state.data?.categories.find((x) => x.id === state.category)
  const own = (note: MemoryNote) =>
    state.scope === "all" || (!!memory.selectedScope() && scopeKey(note.scope) === scopeKey(memory.selectedScope()!))
  const deletable = createMemo(() => memory.filtered().filter(own))
  const status = (note: MemoryNote) => {
    if (state.previewLoading) return "Checking context…"
    if (state.previewError) return "Context unavailable"
    const omitted = state.preview?.omitted.find((x) => x.note.id === note.id)
    if (omitted) return omissionLabel[omitted.reason]
    if (state.preview?.included.some((x) => x.note.id === note.id)) return "In context"
    if (!state.data?.enabled) return "Memory is paused"
    if (!note.enabled) return "Note is paused"
    if (note.expiresAt && note.expiresAt <= Date.now()) return "Expired"
    if (!state.data?.categories.find((x) => x.id === note.categoryID)?.autoRecall) return "Auto-recall is off"
    return "Saved"
  }
  const edit = (note: MemoryNote) => openEditor({ kind: "note", note: { ...note }, scope: { ...note.scope } })
  const remove = (ids: string[]) =>
    memory.setState({
      confirmation: {
        ids,
        revision: state.data!.revision,
        message: `Delete ${ids.length === 1 ? "this memory" : `these ${ids.length} memories`}? This removes the saved notes from future context. Past messages are unchanged.`,
      },
      mutationError: undefined,
    })
  let root: HTMLDivElement | undefined
  onMount(() => {
    const reveal = () => {
      if (!document.hidden && !root?.closest("[data-settings-panel][hidden]") && !state.loading && !state.writing)
        memory.refresh()
    }
    const observer = new MutationObserver(reveal)
    const slot = root?.closest("[data-settings-panel]")
    if (slot) observer.observe(slot, { attributes: true, attributeFilter: ["hidden"] })
    document.addEventListener("visibilitychange", reveal)
    onCleanup(() => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", reveal)
    })
  })
  return (
    <PanelScroll>
      <PanelHeader
        title="Memory"
        description="Keep preferences, research context and cautions ready for future work."
      />
      <PanelBody>
        <div class="memory-panel" ref={root}>
          <div class="memory-heading memory-overview">
            <div>
              <h3>Remember what matters</h3>
              <p class="memory-caption">{label()} · Memories stay on this server.</p>
            </div>
            <div class="memory-inline">
              <span class="memory-caption">{!state.data ? "Unavailable" : state.data.enabled ? "On" : "Paused"}</span>
              <Switch
                checked={state.data?.enabled ?? false}
                disabled={!state.data || locked()}
                hideLabel
                onChange={(enabled) =>
                  void memory.save(
                    "",
                    "PATCH",
                    { enabled },
                    enabled ? "Automatic recall enabled." : "Automatic recall paused. Saved notes are kept.",
                  )
                }
              >
                Enable memory
              </Switch>
            </div>
          </div>
          <Show when={state.error}>
            <div class="memory-error" role="alert">
              {state.error}
              <FormButton label="Retry" variant="ghost" onClick={memory.refresh} disabled={state.loading} />
            </div>
          </Show>
          <Show when={state.data}>
            <div class="memory-toolbar">
              <SearchInput
                value={state.query}
                onInput={(query) => browse(() => memory.setState("query", query))}
                placeholder="Search memories…"
              />
              <IconButton
                icon="refresh"
                aria-label="Refresh memory"
                onClick={memory.refresh}
                disabled={state.loading || state.writing}
              />
            </div>
          </Show>
          <div class="memory-scope-bar">
            <label>
              Scope
              <select
                class="settings-field"
                aria-label="View memory scope"
                value={state.scope}
                disabled={locked()}
                onChange={(event) =>
                  browse(() =>
                    memory.setState({ scope: event.currentTarget.value as typeof state.scope, notice: undefined }),
                  )
                }
              >
                <option value="global">Global</option>
                <option value="project">Project</option>
                <option value="session">Session</option>
                <option value="all">All saved memories</option>
              </select>
            </label>
            <Show when={workspaces && (state.scope === "global" || state.scope === "all")}>
              <label>
                Memory location
                <select
                  class="settings-field"
                  aria-label="Memory server"
                  value={state.remoteID}
                  disabled={locked()}
                  onChange={(event) => browse(() => memory.selectServer(event.currentTarget.value))}
                >
                  <option value="">Local</option>
                  <For each={workspaces?.state.remotes}>
                    {(remote) => (
                      <option value={remote.id} selected={state.remoteID === remote.id}>
                        {remote.name} · {remote.state}
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </Show>
            <Show when={state.scope === "project" || state.scope === "session"}>
              <label>
                Project
                <select
                  class="settings-field"
                  aria-label="Memory project"
                  value={memory.projectValue()}
                  disabled={locked()}
                  onChange={(event) => browse(() => memory.selectProject(event.currentTarget.value))}
                >
                  <option value="">Choose a project</option>
                  <Index each={memory.projects()}>
                    {(project) => (
                      <option value={project().value} selected={memory.projectValue() === project().value}>
                        {project().name}
                        {project().detail ? ` · ${project().detail}` : ""}
                      </option>
                    )}
                  </Index>
                </select>
              </label>
            </Show>
            <Show when={state.scope === "session"}>
              <label>
                Session
                <select
                  class="settings-field"
                  aria-label="Memory session"
                  value={state.sessionID}
                  disabled={locked() || state.catalogLoading || !state.projectID || !memory.available()}
                  onChange={(event) => browse(() => memory.setState("sessionID", event.currentTarget.value))}
                >
                  <option value="">
                    {!memory.available()
                      ? "Connect to load sessions"
                      : state.catalogLoading
                        ? "Loading sessions…"
                        : "Choose a session"}
                  </option>
                  <For each={state.catalog.sessions}>
                    {(session) => (
                      <option value={session.id} selected={state.sessionID === session.id}>
                        {session.parentID ? "↳ " : ""}
                        {session.title}
                        {session.archived ? " (archived)" : ""}
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </Show>
          </div>
          <Show when={state.remoteID && !memory.available()}>
            <div class="memory-connection" role="status">
              <div>
                <h3>
                  {memory.remote()?.name ?? "Remote project"} · {memory.remote()?.state ?? "unavailable"}
                </h3>
                <p class="memory-caption">
                  {memory.remote()?.state === "connecting"
                    ? memory.remote()?.progress || "Connecting in the background…"
                    : "Connect this project to load its memories and sessions. You can keep working while it connects."}
                </p>
                <Show when={state.connectionError || memory.remote()?.error}>
                  <p class="memory-error">{state.connectionError || memory.remote()?.error}</p>
                </Show>
              </div>
              <Show when={memory.remote()}>
                <FormButton
                  label={
                    memory.remote()?.state === "connecting"
                      ? "Connecting…"
                      : memory.remote()?.state === "error"
                        ? "Retry connection"
                        : "Connect"
                  }
                  variant="ghost"
                  disabled={memory.remote()?.state === "connecting"}
                  onClick={() => void memory.connect()}
                />
              </Show>
            </div>
          </Show>
          <Show when={state.loading && !state.data}>
            <p class="memory-empty" role="status">
              Loading memories…
            </p>
          </Show>
          <Show when={state.catalogError}>
            <div class="memory-error" role="alert">
              {state.catalogError}
              <FormButton label="Retry scopes" variant="ghost" onClick={memory.refresh} />
            </div>
          </Show>
          <div class="memory-context-line">
            <p class="memory-caption">
              {state.scope === "global"
                ? "Applies to all projects on this server."
                : state.scope === "project"
                  ? "Applies to every conversation in the selected project."
                  : state.scope === "session"
                    ? "Applies to this conversation and its delegated sessions."
                    : "Browse and manage every saved note on this server."}
            </p>
            <Show when={state.scope === "project" || state.scope === "session"}>
              <label class="memory-checkbox">
                <input
                  type="checkbox"
                  checked={state.inherited}
                  disabled={locked()}
                  onChange={(event) => browse(() => memory.setState("inherited", event.currentTarget.checked))}
                />{" "}
                Include inherited
              </label>
            </Show>
          </div>
          <Show when={state.data}>
            <Show when={state.notice}>
              <p class="memory-notice" role="status">
                {state.notice}
              </p>
            </Show>
            <Show when={state.mutationError && !state.editorOpen}>
              <p class="memory-error" role="alert">
                {state.mutationError}
              </p>
            </Show>
            <Show when={state.confirmation}>
              <div
                class="memory-confirm"
                role="alertdialog"
                aria-label="Confirm memory deletion"
                aria-describedby="memory-delete-description"
                ref={(element) => queueMicrotask(() => element.querySelector<HTMLButtonElement>("button")?.focus())}
              >
                <p id="memory-delete-description">{state.confirmation!.message}</p>
                <div class="memory-actions">
                  <FormButton
                    label="Cancel deletion"
                    variant="ghost"
                    disabled={state.writing}
                    onClick={() => memory.setState({ confirmation: undefined, mutationError: undefined })}
                  />
                  <FormButton
                    label={state.writing ? "Deleting…" : "Delete permanently"}
                    variant="danger"
                    disabled={state.writing}
                    onClick={() => void memory.confirm()}
                  />
                </div>
              </div>
            </Show>
            <Show when={navigation.replacement}>
              <div
                class="memory-confirm"
                role="alertdialog"
                aria-label="Unsaved memory draft"
                aria-describedby="memory-draft-description"
                ref={(element) => queueMicrotask(() => element.querySelector<HTMLButtonElement>("button")?.focus())}
              >
                <p id="memory-draft-description">
                  You have an unfinished draft. Keep editing it, or discard it to open another editor.
                </p>
                <div class="memory-actions">
                  <FormButton
                    label="Keep editing"
                    variant="ghost"
                    onClick={() => {
                      setNavigation("replacement", undefined)
                      memory.resumeEditor()
                    }}
                  />
                  <FormButton
                    label="Discard and continue"
                    variant="danger"
                    onClick={() => {
                      const next = navigation.replacement!
                      setNavigation("replacement", undefined)
                      memory.openEditor(next)
                    }}
                  />
                </div>
              </div>
            </Show>
            <Show when={state.editor && !state.editorOpen && memory.draftDirty()}>
              <div class="memory-draft" role="status">
                <div>
                  <h3>{state.editor?.kind === "note" ? "Unsaved memory" : "Unsaved category"}</h3>
                  <p class="memory-caption">
                    {state.draft?.title || "Untitled draft"}
                    {state.editor?.kind === "note" && state.draft ? ` · ${memory.scopeLabel(state.draft.scope)}` : ""}
                    {" · Your draft is kept while you browse."}
                  </p>
                </div>
                <div class="memory-actions">
                  <FormButton
                    label="Resume editing"
                    variant="ghost"
                    disabled={locked()}
                    onClick={memory.resumeEditor}
                  />
                  <FormButton label="Discard draft" variant="ghost" disabled={locked()} onClick={memory.closeEditor} />
                </div>
              </div>
            </Show>
            <div class="memory-library">
              <nav class="memory-categories" aria-label="Memory categories">
                <button
                  type="button"
                  aria-current={state.category === "all" ? "true" : undefined}
                  disabled={locked()}
                  onClick={() => browse(() => memory.setState("category", "all"))}
                >
                  <Icon name="brain" size="small" />
                  <span>All categories</span>
                  <span class="memory-count">{memory.inScope().length}</span>
                </button>
                <For each={state.data?.categories}>
                  {(item) => (
                    <button
                      type="button"
                      aria-current={state.category === item.id ? "true" : undefined}
                      disabled={locked()}
                      onClick={() => browse(() => memory.setState("category", item.id))}
                    >
                      <Icon name="book-open" size="small" />
                      <span>{item.name}</span>
                      <span class="memory-count">
                        {memory.inScope().filter((x) => x.categoryID === item.id).length}
                      </span>
                    </button>
                  )}
                </For>
                <button
                  type="button"
                  class="memory-category-add"
                  disabled={locked() || (state.data?.categories.length ?? 0) >= 24}
                  onClick={() => openEditor({ kind: "category" })}
                >
                  <Icon name="plus" size="small" />
                  <span>New category</span>
                </button>
              </nav>
              <section class="memory-content" aria-label="Saved memories">
                <Show
                  when={state.editorOpen ? state.editorVersion : undefined}
                  keyed
                  fallback={
                    <>
                      <div class="memory-heading memory-library-header">
                        <div>
                          <h3>{category()?.name ?? "Saved memories"}</h3>
                          <Show when={category()?.description}>
                            <p class="memory-caption">{category()?.description}</p>
                          </Show>
                        </div>
                        <div class="memory-inline">
                          <Show when={category()}>
                            <IconButton
                              icon="pencil-line"
                              aria-label="Edit category"
                              disabled={locked()}
                              onClick={() => openEditor({ kind: "category", category: { ...category()! } })}
                            />
                          </Show>
                          <FormButton
                            label="Add memory"
                            disabled={
                              locked() || !memory.selectedScope() || (state.catalogLoading && state.scope !== "global")
                            }
                            onClick={() => openEditor({ kind: "note", scope: memory.selectedScope()! })}
                          />
                        </div>
                      </div>
                      <Show when={category()}>
                        <div class="memory-category-controls">
                          <span class="memory-caption">Auto-recall</span>
                          <Switch
                            checked={category()?.autoRecall ?? false}
                            hideLabel
                            disabled={locked()}
                            onChange={(autoRecall) => {
                              const value = category()!
                              void memory.save(
                                `/categories/${value.id}`,
                                "PUT",
                                { category: { name: value.name, description: value.description, autoRecall } },
                                "Category updated.",
                              )
                            }}
                          >
                            Auto-recall {category()?.name}
                          </Switch>
                          <Show when={category()?.id !== "about-you"}>
                            <button
                              class="memory-text-button"
                              type="button"
                              disabled={locked() || state.data!.notes.some((x) => x.categoryID === category()!.id)}
                              title="A category must be empty before it can be deleted"
                              onClick={() =>
                                memory.setState("confirmation", {
                                  categoryID: category()!.id,
                                  revision: state.data!.revision,
                                  message: `Delete the empty category “${category()!.name}”?`,
                                })
                              }
                            >
                              Delete category
                            </button>
                          </Show>
                        </div>
                      </Show>
                      <Show
                        when={memory.filtered().length}
                        fallback={
                          <div class="memory-empty">
                            <Icon name="brain" size="large" />
                            <h4>{state.query ? "No matching memories" : "A little context goes a long way"}</h4>
                            <p>
                              {state.query
                                ? "Try another search or scope."
                                : !memory.selectedScope()
                                  ? "Choose a project or session, or select Global to add a memory."
                                  : "Save a preference, a lab convention or a known pitfall. OneLab will recall it when you work in this scope."}
                            </p>
                          </div>
                        }
                      >
                        <div class="memory-notes">
                          <For each={memory.filtered()}>
                            {(note) => (
                              <article class="memory-note">
                                <div class="memory-heading">
                                  <button
                                    class="memory-note-title"
                                    type="button"
                                    disabled={locked()}
                                    onClick={() => edit(note)}
                                  >
                                    {note.title}
                                  </button>
                                  <div class="memory-inline">
                                    <IconButton
                                      icon="pencil-line"
                                      aria-label={`Edit memory ${note.title}`}
                                      disabled={locked()}
                                      onClick={() => edit(note)}
                                    />
                                    <IconButton
                                      icon="trash"
                                      aria-label={`Delete memory ${note.title}`}
                                      disabled={locked()}
                                      onClick={() => remove([note.id])}
                                    />
                                  </div>
                                </div>
                                <p class="memory-note-body">{note.content}</p>
                                <div class="memory-note-meta">
                                  <span class="memory-badge">
                                    {note.scope.kind === "global"
                                      ? "Global"
                                      : `${note.scope.kind === "project" ? "Project" : "Session"} · ${memory.scopeLabel(note.scope)}`}
                                  </span>
                                  <Show when={!own(note)}>
                                    <span class="memory-badge">Inherited</span>
                                  </Show>
                                  <span class="memory-caption">{status(note)}</span>
                                  <Switch
                                    checked={note.enabled}
                                    hideLabel
                                    disabled={locked()}
                                    onChange={(enabled) => {
                                      const { id, createdAt, updatedAt, ...value } = note
                                      void memory.save(
                                        `/notes/${id}`,
                                        "PUT",
                                        { note: { ...value, enabled } },
                                        enabled ? "Memory enabled." : "Memory paused.",
                                      )
                                    }}
                                  >
                                    Use memory {note.title}
                                  </Switch>
                                </div>
                                <Show when={note.expiresAt}>
                                  <p class="memory-caption">Expires {new Date(note.expiresAt!).toLocaleString()}</p>
                                </Show>
                              </article>
                            )}
                          </For>
                        </div>
                        <div class="memory-list-footer">
                          <span class="memory-caption">{memory.filtered().length} notes shown</span>
                          <button
                            type="button"
                            class="memory-text-button"
                            disabled={locked() || !deletable().length}
                            onClick={() => remove(deletable().map((x) => x.id))}
                          >
                            Clear {state.scope === "all" ? "shown notes" : "notes in this scope"}
                          </button>
                        </div>
                      </Show>
                    </>
                  }
                >
                  {(_version) => (
                    <MemoryEditor
                      editor={state.editor!}
                      memory={memory}
                      blocked={!!navigation.replacement || !!state.confirmation}
                    />
                  )}
                </Show>
              </section>
            </div>
            <Show when={memory.selectedScope()}>
              <details class="memory-preview">
                <summary>
                  <Icon name="code" size="small" />
                  <div>
                    <span>Context preview</span>
                    <p class="memory-caption">
                      {state.previewLoading
                        ? "Checking what will be recalled…"
                        : state.preview
                          ? `${state.preview.included.length} included · ${state.preview.inherited} inherited · ${state.preview.omitted.length} omitted`
                          : "Inspect memory for this scope"}
                    </p>
                  </div>
                  <Icon name="chevron-down" size="small" />
                </summary>
                <div class="memory-preview-body" aria-live="polite">
                  <Show when={state.previewError}>
                    <p class="memory-error" role="alert">
                      {state.previewError}
                    </p>
                  </Show>
                  <Show when={state.preview}>
                    {(preview) => (
                      <>
                        <p class="memory-caption">
                          Applied to the next model request. {preview().characters.toLocaleString()} /{" "}
                          {preview().maxCharacters.toLocaleString()} characters · up to {preview().maxNotes} notes.
                          Session → project → global precedence uses the same title within a category.
                        </p>
                        <For each={preview().included}>
                          {(item) => (
                            <div class="memory-preview-row">
                              <span>{item.note.title}</span>
                              <span class="memory-caption">{item.inherited ? "Inherited" : "Included"}</span>
                            </div>
                          )}
                        </For>
                        <For each={preview().omitted}>
                          {(item) => (
                            <div class="memory-preview-row">
                              <span>{item.note.title}</span>
                              <span class="memory-caption">{omissionLabel[item.reason]}</span>
                            </div>
                          )}
                        </For>
                        <Show
                          when={preview().system}
                          fallback={<p class="memory-caption">No saved memory will be added to context.</p>}
                        >
                          <details class="memory-prompt">
                            <summary>View exact injected text</summary>
                            <pre>{preview().system}</pre>
                          </details>
                        </Show>
                      </>
                    )}
                  </Show>
                </div>
              </details>
            </Show>
          </Show>
        </div>
      </PanelBody>
    </PanelScroll>
  )
}

export default Memory
