import { For, Show, onMount } from "solid-js"
import { reconcile } from "solid-js/store"
import { Switch } from "@synsci/ui/switch"
import { FormButton, FormField } from "./_shared"
import { scopeKey, type MemoryEditor as Editor, type MemoryState, type MemoryScope } from "./memory-state"

export function MemoryEditor(props: { editor: Editor; memory: MemoryState; blocked?: boolean }) {
  const original = props.editor
  const memory = props.memory
  const note = original.kind === "note" ? original.note : undefined
  const category = original.kind === "category" ? original.category : undefined
  const scope = original.kind === "note" ? original.scope : { kind: "global" as const }
  const draft = memory.state.draft!
  const locked = () => memory.state.writing || !!props.blocked
  let root: HTMLFormElement | undefined
  onMount(() => root?.querySelector<HTMLInputElement>("input")?.focus())
  const scopes = () => {
    const list: MemoryScope[] = [{ kind: "global" }]
    if (memory.state.projectID) list.push({ kind: "project", projectID: memory.state.projectID })
    if (memory.state.projectID && memory.state.sessionID)
      list.push({ kind: "session", projectID: memory.state.projectID, sessionID: memory.state.sessionID })
    if (!list.some((x) => scopeKey(x) === scopeKey(scope))) list.push(scope)
    if (!list.some((x) => scopeKey(x) === scopeKey(draft.scope))) list.push(draft.scope)
    return list
  }
  const submit = async () => {
    if (locked()) return
    const epoch = memory.state.epoch
    const title = draft.title.trim()
    const content = draft.content.trim()
    const expiresAt = draft.expires ? new Date(draft.expires).getTime() : null
    const error = !title
      ? "Enter a title."
      : title.length > (original.kind === "note" ? 100 : 60)
        ? "The title is too long."
        : original.kind === "note" && !content
          ? "Enter something to remember."
          : content.length > (original.kind === "note" ? 4_000 : 500)
            ? "The text is too long."
            : original.kind === "note" && !memory.state.data?.categories.some((item) => item.id === draft.categoryID)
              ? "Choose an available category."
              : expiresAt !== null && !Number.isFinite(expiresAt)
                ? "Choose a valid expiration date."
                : ""
    memory.setState("draft", "error", error)
    if (error) {
      root?.querySelector<HTMLElement>('[role="alert"]')?.focus()
      return
    }
    const result =
      original.kind === "note"
        ? await memory.save(
            `/notes${note ? `/${note.id}` : ""}`,
            note ? "PUT" : "POST",
            {
              revision: draft.revision,
              note: {
                title,
                content,
                categoryID: draft.categoryID,
                scope: draft.scope,
                enabled: draft.enabled,
                expiresAt,
              },
            },
            "Memory saved. It will be considered for the next model request.",
          )
        : await memory.save(
            `/categories${category ? `/${category.id}` : ""}`,
            category ? "PUT" : "POST",
            {
              revision: draft.revision,
              category: { name: title, description: content, autoRecall: draft.enabled },
            },
            "Category saved.",
          )
    // 旧表单的异步响应不能关闭另一个后端的编辑器或改写它的草稿版本。
    if (epoch !== memory.state.epoch) return
    if (result) memory.closeEditor()
    else if (memory.state.data) memory.setState("draft", "revision", memory.state.data.revision)
  }
  return (
    <form
      class="memory-editor"
      ref={root}
      aria-label={original.kind === "note" ? "Memory editor" : "Category editor"}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div class="memory-heading">
        <h3>
          {original.kind === "note"
            ? note
              ? "Edit memory"
              : "New memory"
            : category
              ? "Edit category"
              : "New category"}
        </h3>
      </div>
      <Show when={draft.error || memory.state.mutationError}>
        <p class="memory-error" role="alert" tabindex="-1">
          {draft.error || memory.state.mutationError}
        </p>
      </Show>
      <FormField
        label={original.kind === "note" ? "Title" : "Name"}
        value={draft.title}
        onInput={(value) => memory.setState("draft", "title", value)}
        placeholder={original.kind === "note" ? "e.g. Reproducibility requirements" : "e.g. Lab conventions"}
        disabled={locked()}
      />
      <Show when={original.kind === "note"}>
        <div class="memory-fields">
          <label>
            Save in
            <select
              class="settings-field"
              aria-label="Memory scope"
              value={scopeKey(draft.scope)}
              disabled={locked()}
              onChange={(event) => {
                const scope = scopes().find((x) => scopeKey(x) === event.currentTarget.value)
                if (scope) memory.setState("draft", "scope", reconcile(scope))
              }}
            >
              <For each={scopes()}>
                {(scope) => (
                  <option value={scopeKey(scope)} selected={scopeKey(draft.scope) === scopeKey(scope)}>
                    {scope.kind === "global"
                      ? "Global · all projects on this server"
                      : `${scope.kind === "project" ? "Project" : "Session"} · ${memory.scopeLabel(scope)}`}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label>
            Category
            <select
              class="settings-field"
              aria-label="Memory category"
              value={draft.categoryID}
              disabled={locked()}
              onChange={(event) => memory.setState("draft", "categoryID", event.currentTarget.value)}
            >
              <Show when={!memory.state.data?.categories.some((item) => item.id === draft.categoryID)}>
                <option value={draft.categoryID} selected disabled>
                  Category no longer available
                </option>
              </Show>
              <For each={memory.state.data?.categories}>
                {(item) => (
                  <option value={item.id} selected={draft.categoryID === item.id}>
                    {item.name}
                  </option>
                )}
              </For>
            </select>
          </label>
        </div>
      </Show>
      <FormField
        label={original.kind === "note" ? "What should OneLab remember?" : "What belongs in this category?"}
        value={draft.content}
        onInput={(value) => memory.setState("draft", "content", value)}
        multiline
        disabled={locked()}
        placeholder={
          original.kind === "note"
            ? "e.g. Use a fixed random seed, record package versions, and keep source data unchanged."
            : "Describe the preferences, facts or cautions you want to keep here."
        }
      />
      <p class="memory-caption">
        {draft.content.length.toLocaleString()} / {original.kind === "note" ? "4,000" : "500"} characters
      </p>
      <div class="memory-heading">
        <div>
          <h4>{original.kind === "note" ? "Use this memory" : "Auto-recall"}</h4>
          <p class="memory-caption">
            {original.kind === "note"
              ? "Pausing keeps the note without adding it to context."
              : "Off keeps notes saved and searchable, without automatic context injection."}
          </p>
        </div>
        <Switch
          checked={draft.enabled}
          onChange={(value) => memory.setState("draft", "enabled", value)}
          disabled={locked()}
          hideLabel
        >
          {original.kind === "note" ? "Use this memory" : "Category auto-recall"}
        </Switch>
      </div>
      <Show when={original.kind === "note"}>
        <label class="memory-expiry">
          Expires <span class="memory-caption">(optional, your local time)</span>
          <input
            class="settings-field"
            aria-label="Memory expiration"
            type="datetime-local"
            value={draft.expires}
            onInput={(event) => memory.setState("draft", "expires", event.currentTarget.value)}
            disabled={locked()}
          />
        </label>
        <p class="memory-caption">
          Within a category, the same title in a session overrides the project and global versions. Current requests
          take precedence over saved preferences.
        </p>
      </Show>
      <div class="memory-actions">
        <FormButton label="Cancel" variant="ghost" disabled={locked()} onClick={memory.closeEditor} />
        <button class="settings-button" data-variant="primary" type="submit" disabled={locked()}>
          {memory.state.writing ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  )
}
