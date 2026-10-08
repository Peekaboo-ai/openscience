import { ErrorBoundary, Show, createEffect, createMemo, on, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { get, type ArtifactInspection, type ArtifactKind } from "./renderers"

/**
 * Dispatcher for scientific artifacts rendered inline in chat.
 *
 * Given `{ kind, data }`, looks up the registered renderer for `kind` and mounts
 * it. If no renderer is registered (or it throws at mount), falls back to a
 * graceful placeholder + a collapsed JSON dump so the artifact is never lost.
 *
 * Integration: a tool renderer registered via `@synsci/ui/message-part`'s
 * `ToolRegistry.register(...)` reads the science-artifact envelope from a tool
 * part's `metadata` and mounts this component. See SCIENCE_PATTERNS.md.
 */

export interface ScienceArtifactProps {
  kind: ArtifactKind
  data: unknown
  height?: number
  onInspect?: (inspection: ArtifactInspection) => void
}

export function ScienceArtifact(props: ScienceArtifactProps): JSX.Element {
  const renderer = createMemo(() => get(props.kind))

  return (
    <div data-component="science-artifact" data-kind={props.kind}>
      <ErrorBoundary fallback={(error, reset) => <ScienceArtifactFailure {...props} error={error} reset={reset} />}>
        <Show when={renderer()} fallback={<ScienceArtifactFallback kind={props.kind} data={props.data} />}>
          {(Renderer) => (
            <Dynamic
              component={Renderer()}
              kind={props.kind}
              data={props.data}
              height={props.height}
              onInspect={props.onInspect}
            />
          )}
        </Show>
      </ErrorBoundary>
    </div>
  )
}

function ScienceArtifactFailure(props: ScienceArtifactProps & { error: unknown; reset: () => void }) {
  // 只隔离当前产物；新数据到达时重试，避免一次解析失败替换整段会话或后续产物。
  createEffect(
    on(
      () => [props.kind, props.data],
      () => props.reset(),
      { defer: true },
    ),
  )
  return (
    <ScienceArtifactFallback
      kind={props.kind}
      data={props.data}
      error={props.error instanceof Error ? props.error.message : String(props.error)}
      retry={props.reset}
    />
  )
}

function ScienceArtifactFallback(props: {
  kind: ArtifactKind
  data: unknown
  error?: string
  retry?: () => void
}): JSX.Element {
  const preview = createMemo(() => {
    try {
      return JSON.stringify(props.data, null, 2).slice(0, 2000)
    } catch {
      return String(props.data)
    }
  })
  return (
    <div data-component="science-artifact-fallback">
      <div data-slot="science-artifact-fallback-title" role={props.error ? "alert" : undefined}>
        {props.error
          ? `Could not render this artifact: ${props.error}`
          : `No renderer registered for artifact kind “${props.kind}”.`}
      </div>
      <Show when={props.retry}>
        <button type="button" onClick={() => props.retry?.()}>
          Retry preview
        </button>
      </Show>
      <details data-slot="science-artifact-fallback-details">
        <summary>Raw artifact data</summary>
        <pre>{preview()}</pre>
      </details>
    </div>
  )
}
