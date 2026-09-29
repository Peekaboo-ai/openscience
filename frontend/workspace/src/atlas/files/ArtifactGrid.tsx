import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { StoredArtifact } from "@/artifacts/store"
import { ArtifactCard } from "./ArtifactCard"
import type { ThumbProps } from "./ArtifactThumb"
import { groupBySession, sessionLabel, sortArtifacts, type Group } from "./artifact-groups"
import { ARTIFACT_TYPES, filterArtifacts, type ArtifactType } from "./artifact-catalog"
import { readView, writeView, type View } from "./artifact-view"
import { age } from "./ago"
import { IconChevronDown } from "@/atlas/shared/Icon"
import "./file-items.css"

export interface GridProps extends Omit<ThumbProps, "artifact"> {
  artifacts: StoredArtifact[]
  catalog?: StoredArtifact[]
  titles: Map<string, string>
  currentSession: string | undefined
  scopeKey?: string
  /** Set while the pane's search box is filtering, so an empty grid can say why. */
  filtered?: boolean
  /** Empty data during loading or a failed request is not a true empty state. */
  loading?: boolean
  unavailable?: boolean
  onOpen: (artifact: StoredArtifact) => void
  onDownload: (artifact: StoredArtifact) => void
  onRename: (artifact: StoredArtifact) => void
  onTrash: (artifact: StoredArtifact) => void
}

export function ArtifactGrid(props: GridProps): JSX.Element {
  const [filter, setFilter] = createStore({ scope: "project", session: "", type: "all" as ArtifactType })
  createEffect(() => {
    props.scopeKey
    setFilter({ scope: "project", session: "", type: "all" })
  })
  const sessions = createMemo(() =>
    groupBySession(props.catalog ?? props.artifacts, props.titles, props.currentSession),
  )
  const visible = createMemo(() =>
    filterArtifacts(props.artifacts, {
      session: filter.scope === "session" ? (props.currentSession ?? "") : filter.session || undefined,
      type: filter.type,
    }),
  )
  const filtering = () => props.filtered || filter.scope === "session" || !!filter.session || filter.type !== "all"
  const [view, setView] = createSignal<View>(readView())
  const [prefs, setPrefs] = createSignal(false)
  const refs: { trigger?: HTMLButtonElement; menu?: HTMLDivElement } = {}
  const options = () => Array.from(refs.menu?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])
  const focusOption = (option: HTMLButtonElement | undefined) => {
    if (!option) return
    options().forEach((candidate) => (candidate.tabIndex = candidate === option ? 0 : -1))
    option.focus()
  }
  const openPrefs = () => {
    setPrefs(true)
    queueMicrotask(() => focusOption(options()[0]))
  }
  const closePrefs = (restoreFocus = false) => {
    setPrefs(false)
    if (restoreFocus) queueMicrotask(() => refs.trigger?.focus())
  }

  // Spread rather than mutate: readView() hands back the shared DEFAULT_VIEW
  // object itself whenever storage is empty or invalid, and writing through it
  // would rewrite the default for every later reader in the process.
  const apply = (next: Partial<View>) => {
    const merged = { ...view(), ...next }
    setView(merged)
    writeView(merged)
  }

  // Each field gets its own memo. Reading view().sort inside the grouping memo
  // subscribed it to the whole object, and apply() always writes a fresh one, so
  // toggling layout or file sizes rebuilt every Group -- which made <For>
  // recreate every card and re-read every artifact's bytes.
  const sort = createMemo(() => view().sort)
  const layout = createMemo(() => view().layout)
  const sizes = createMemo(() => view().sizes)

  // One group with no label is how the flat A-Z case reuses the grouped render
  // path; the header is what disappears, not the list.
  const groups = createMemo((): Group[] =>
    sort() === "created"
      ? groupBySession(visible(), props.titles, props.currentSession)
      : [{ key: "all", label: "", artifacts: sortArtifacts(visible(), "name"), newest: 0 }],
  )

  const card = (artifact: StoredArtifact) => (
    <ArtifactCard
      artifact={artifact}
      sessionLabel={
        props.titles.get(artifact.current.sessionID)?.trim() ||
        sessionLabel(artifact.current.sessionID, props.titles, props.currentSession)
      }
      layout={layout()}
      sizes={sizes()}
      read={props.read}
      highlight={props.highlight}
      onOpen={props.onOpen}
      onDownload={props.onDownload}
      onRename={props.onRename}
      onTrash={props.onTrash}
    />
  )

  return (
    <div class="artifact-surface">
      <div class="artifact-catalog-filters">
        <div class="artifact-catalog-scope" role="group" aria-label="Artifact scope">
          <button type="button" aria-pressed={filter.scope === "project"} onClick={() => setFilter("scope", "project")}>
            This project
          </button>
          <button
            type="button"
            aria-pressed={filter.scope === "session"}
            disabled={!props.currentSession}
            onClick={() => setFilter("scope", "session")}
          >
            This session
          </button>
        </div>
        <div class="artifact-catalog-selects">
          <Show when={filter.scope === "project"}>
            <label>
              <span>Session</span>
              <select
                aria-label="Filter artifacts by session"
                value={filter.session}
                onChange={(event) => setFilter("session", event.currentTarget.value)}
              >
                <option value="">All sessions</option>
                <For each={sessions()}>
                  {(group) => (
                    <option value={group.key}>
                      {props.titles.get(group.key)?.trim() || group.label} · {group.key.slice(-6)}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </Show>
          <label>
            <span>Type</span>
            <select
              aria-label="Filter artifacts by type"
              value={filter.type}
              onChange={(event) => setFilter("type", event.currentTarget.value as ArtifactType)}
            >
              <For each={ARTIFACT_TYPES}>{(type) => <option value={type.value}>{type.label}</option>}</For>
            </select>
          </label>
        </div>
      </div>
      <div class="artifact-toolbar">
        <span class="artifact-toolbar__primary">
          <span class="artifact-toolbar__count" data-artifact-count>
            {visible().length} {visible().length === 1 ? "result" : "results"}
          </span>
          <span class="artifact-toolbar__hint">Saved artifacts</span>
        </span>

        {/* Sorting, layout and the optional size column are one mental model:
            how this catalog is presented. Keeping them behind one familiar
            text control leaves a 320px pane usable without deleting choices. */}
        <span class="artifact-toolbar__controls">
          <button
            ref={(element) => {
              refs.trigger = element
            }}
            type="button"
            class="artifact-toolbar__prefs"
            data-artifact-prefs
            aria-label="Artifact view options"
            aria-expanded={prefs()}
            onClick={() => (prefs() ? closePrefs() : openPrefs())}
          >
            View
            <IconChevronDown size={12} strokeWidth={1.5} />
          </button>

          <Show when={prefs()}>
            <button
              type="button"
              class="artifact-menu__scrim"
              aria-label="Dismiss artifact view options"
              onClick={() => closePrefs(true)}
            />
            {/* The backend does not expose the artifact-store path, so this menu
                contains presentation choices only. No guessed location or
                unsupported storage mode is presented as fact. */}
            <div
              ref={(element) => {
                refs.menu = element
              }}
              class="artifact-menu artifact-menu--prefs"
              role="menu"
              aria-label="Artifact view options"
              onKeyDown={(event) => {
                if (event.key === "Escape" || event.key === "Tab") {
                  event.preventDefault()
                  closePrefs(true)
                  return
                }
                const items = options()
                const current = items.indexOf(document.activeElement as HTMLButtonElement)
                const target =
                  event.key === "Home"
                    ? items[0]
                    : event.key === "End"
                      ? items.at(-1)
                      : event.key === "ArrowDown"
                        ? items[(current + 1 + items.length) % items.length]
                        : event.key === "ArrowUp"
                          ? items[(current - 1 + items.length) % items.length]
                          : undefined
                if (!target) return
                event.preventDefault()
                focusOption(target)
              }}
            >
              <span class="artifact-menu__section" role="presentation">
                Sort
              </span>
              <For each={["created", "name"] as const}>
                {(option) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    tabindex="-1"
                    data-artifact-sort={option}
                    aria-checked={sort() === option}
                    onClick={() => apply({ sort: option })}
                  >
                    <span aria-hidden="true" class="artifact-menu__check">
                      {sort() === option ? "✓" : ""}
                    </span>
                    {option === "created" ? "Recently saved" : "Name A–Z"}
                  </button>
                )}
              </For>

              <span class="artifact-menu__section" role="presentation">
                Layout
              </span>
              <For each={["grid", "list"] as const}>
                {(option) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    tabindex="-1"
                    data-artifact-layout={option}
                    aria-checked={layout() === option}
                    onClick={() => apply({ layout: option })}
                  >
                    <span aria-hidden="true" class="artifact-menu__check">
                      {layout() === option ? "✓" : ""}
                    </span>
                    {option === "grid" ? "Grid" : "List"}
                  </button>
                )}
              </For>

              <span class="artifact-menu__separator" role="separator" />
              <button
                type="button"
                role="menuitemcheckbox"
                tabindex="-1"
                aria-checked={sizes()}
                data-pref="sizes"
                onClick={() => apply({ sizes: !sizes() })}
              >
                <span aria-hidden="true" class="artifact-menu__check">
                  {sizes() ? "✓" : ""}
                </span>
                Show file sizes
              </button>
            </div>
          </Show>
        </span>
      </div>

      <Show
        when={visible().length > 0}
        fallback={
          <Show when={!props.loading && !props.unavailable}>
            {/* "No artifacts saved yet." is false when a search simply matched
                nothing, and the count beside it already says 0. */}
            <div class="files-empty files-empty--artifacts" data-artifact-empty>
              <strong>{filtering() ? "No matching results" : "No saved results yet"}</strong>
              <span>
                {filtering()
                  ? "Try another session or file type, or clear the search."
                  : "Save a file to Results from its preview, or ask the agent to save a deliverable. Artifacts from this project appear here, grouped by session."}
              </span>
              <Show when={filter.scope !== "project" || filter.session || filter.type !== "all"}>
                <button
                  type="button"
                  class="artifact-toolbar__prefs"
                  onClick={() => setFilter({ scope: "project", session: "", type: "all" })}
                >
                  Clear filters
                </button>
              </Show>
            </div>
          </Show>
        }
      >
        <For each={groups()}>
          {(group) => (
            <>
              <Show when={group.label}>
                <div class="artifact-group" data-artifact-group>
                  <span class="artifact-group__name">{group.label}</span>
                  <span class="artifact-group__id" title={group.key}>
                    {group.key.slice(-6)}
                  </span>
                  <span class="artifact-group__meta">
                    {group.artifacts.length} · {age(group.newest)}
                  </span>
                </div>
              </Show>
              <div
                class={layout() === "grid" ? "artifact-grid" : "artifact-list"}
                {...(layout() === "grid" ? { "data-artifact-grid": true } : { "data-artifact-list": true })}
              >
                <For each={group.artifacts}>{card}</For>
              </div>
            </>
          )}
        </For>
      </Show>
    </div>
  )
}
