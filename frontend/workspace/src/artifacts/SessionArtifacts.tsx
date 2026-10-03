import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { TurnArtifactsProps } from "@synsci/ui/context/data"
import { Spinner } from "@synsci/ui/spinner"
import { IconChevronDown, IconRefresh } from "@/atlas/shared/Icon"
import { ArtifactThumb } from "@/atlas/files/ArtifactThumb"
import { bytes } from "@/atlas/files/bytes"
import { requestStoredArtifact, type ArtifactTransport } from "./bytes"
import { orderTurnArtifacts, type createArtifactPublication, type TurnArtifactsReport } from "./publication"
import type { StoredArtifact } from "./store"
import "@/atlas/files/FilesPane.css"
import "./session-artifacts.css"

const VISIBLE = 5

export function SessionArtifacts(
  props: TurnArtifactsProps & {
    scope: string
    load: ReturnType<typeof createArtifactPublication>
    request: ArtifactTransport
    onOpen: (artifact: StoredArtifact) => void
    onOpenFile: (path: string) => void
  },
) {
  const [state, setState] = createStore({
    loading: false,
    expanded: false,
    error: "",
    report: { artifacts: [], failures: [], published: 0, truncated: false } as TurnArtifactsReport,
  })
  const owner = createMemo(() => JSON.stringify([props.scope, props.sessionID, props.finalMessageID, props.messageIDs]))
  let mounted = true
  onCleanup(() => (mounted = false))
  const load = (refresh = false) => {
    const ticket = owner()
    const scope = props.scope
    const sessionID = props.sessionID
    setState({ loading: true, error: "" })
    void props
      .load(scope, { sessionID, messageIDs: props.messageIDs, finalMessageID: props.finalMessageID }, refresh)
      .then(
        (report) => {
          if (!mounted || owner() !== ticket) return
          setState({ loading: false, report })
          if (report.published > 0)
            window.dispatchEvent(
              new CustomEvent("openscience:artifacts-changed", { detail: { scope, sessionID, source: "publication" } }),
            )
        },
        (error: unknown) => {
          if (!mounted || owner() !== ticket) return
          setState({ loading: false, error: error instanceof Error ? error.message : String(error) })
        },
      )
  }
  createEffect(() => {
    owner()
    setState({ expanded: false, report: { artifacts: [], failures: [], published: 0, truncated: false } })
    if (props.messageIDs.length) load()
  })
  onMount(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.source === "publication") return
      load(true)
    }
    window.addEventListener("openscience:artifacts-changed", changed)
    onCleanup(() => window.removeEventListener("openscience:artifacts-changed", changed))
  })
  const artifacts = createMemo(() => orderTurnArtifacts(state.report.artifacts))
  const visible = createMemo(() => (state.expanded ? artifacts() : artifacts().slice(0, VISIBLE)))
  const remaining = () => artifacts().length - VISIBLE
  const read = (artifact: StoredArtifact) =>
    requestStoredArtifact(props.request, artifact.id, artifact.current.id).then((response) => response.blob())

  return (
    <Show when={state.loading || state.error || artifacts().length || state.report.failures.length}>
      <section class="session-artifacts" aria-label="Generated results" aria-busy={state.loading}>
        <header class="session-artifacts__header">
          <strong>Generated</strong>
          <Show when={artifacts().length}>
            <span>· {artifacts().length}</span>
          </Show>
          <Show when={state.loading}>
            <Spinner class="session-artifacts__spinner" />
          </Show>
          <Show when={state.expanded && remaining() > 0}>
            <button type="button" class="session-artifacts__collapse" onClick={() => setState("expanded", false)}>
              Show less <IconChevronDown size={12} style={{ transform: "rotate(180deg)" }} />
            </button>
          </Show>
        </header>
        <Show when={artifacts().length}>
          <div class="session-artifacts__grid">
            <For each={visible()}>
              {(artifact) => (
                <button
                  type="button"
                  class="session-artifacts__item"
                  data-generated-artifact={artifact.id}
                  aria-label={`Open ${artifact.current.filename}, version ${artifact.current.version}`}
                  title={`${artifact.title} · Version ${artifact.current.version}`}
                  onClick={() => props.onOpen(artifact)}
                >
                  <span class="session-artifacts__preview">
                    <ArtifactThumb artifact={artifact} read={read} />
                  </span>
                  <span class="session-artifacts__filename">{artifact.current.filename}</span>
                  <span class="session-artifacts__meta">
                    {artifact.current.filename.split(".").at(-1)?.toUpperCase()} · {bytes(artifact.current.size)}
                  </span>
                </button>
              )}
            </For>
            <Show when={!state.expanded && remaining() > 0}>
              <button
                type="button"
                class="session-artifacts__more"
                aria-expanded="false"
                onClick={() => setState("expanded", true)}
              >
                <span>+{remaining()} more</span>
                <IconChevronDown size={16} />
              </button>
            </Show>
          </div>
        </Show>
        <Show when={state.error}>
          <div class="session-artifacts__status" role="status">
            <span>Results could not be loaded.</span>
            <button type="button" disabled={state.loading} title={state.error} onClick={() => load(true)}>
              <IconRefresh size={13} /> Retry
            </button>
          </div>
        </Show>
        <Show when={state.report.failures.length}>
          <details class="session-artifacts__failures">
            <summary>
              {state.report.failures.length} {state.report.failures.length === 1 ? "file could" : "files could"} not be
              saved
            </summary>
            <For each={state.report.failures}>
              {(failure) => (
                <button type="button" title={failure.message} onClick={() => props.onOpenFile(failure.path)}>
                  {failure.path.replaceAll("\\", "/").split("/").at(-1)}
                </button>
              )}
            </For>
            <button type="button" disabled={state.loading} onClick={() => load(true)}>
              <IconRefresh size={13} /> Retry saving
            </button>
          </details>
        </Show>
        <Show when={state.report.truncated}>
          <span class="session-artifacts__status">Additional files remain linked in the response.</span>
        </Show>
      </section>
    </Show>
  )
}
