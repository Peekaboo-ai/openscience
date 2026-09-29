import { ErrorBoundary, Match, Suspense, Switch, createMemo, lazy, type JSX } from "solid-js"
import { DataTableView } from "@/data/DataTableView"
import { MarkdownDocument } from "../MarkdownDocument"
import { NotebookDocument } from "./NotebookDocument"
import type { ViewerResolution } from "./viewer-registry"
import { detectScientificFile } from "@/science/files"
import { detectBiologicalFormat } from "@/science/formats/biological"
import { rewriteHtmlAssets } from "@/utils/html-assets"
import "../FilePreview.css"
import "./artifact-preview.css"

const ScienceArtifact = lazy(() =>
  import("@/science/ScienceArtifact").then((module) => ({ default: module.ScienceArtifact })),
)
const ScientificDataView = lazy(() =>
  import("@/science/formats/ScientificDataView").then((module) => ({ default: module.ScientificDataView })),
)

export function TextContentView(props: {
  name: string
  text: string
  viewer: ViewerResolution
  resolveAsset?: (src: string) => string
}): JSX.Element {
  const science = createMemo(() =>
    props.viewer.kind === "science" ? detectScientificFile(props.viewer.extension, props.text) : undefined,
  )
  const biological = createMemo(() =>
    props.viewer.kind === "scientific-data" ? detectBiologicalFormat(props.viewer.extension) : undefined,
  )
  const html = createMemo(() =>
    props.viewer.kind === "html"
      ? rewriteHtmlAssets(
          props.text,
          props.resolveAsset ?? ((src) => (/^(data:|blob:|#)/.test(src) ? src : "about:blank")),
        )
      : "",
  )
  return (
    <ErrorBoundary
      fallback={
        <p class="atlas-file-notice" role="alert">
          Couldn’t render this file. Use Source or Download to inspect the original.
        </p>
      }
    >
      <Suspense
        fallback={
          <p class="atlas-file-notice" role="status">
            Loading renderer…
          </p>
        }
      >
        <Switch fallback={<pre class="remote-view__text">{props.text}</pre>}>
          <Match when={science()}>
            {(artifact) => (
              <div class="atlas-file-science">
                <ScienceArtifact kind={artifact().kind} data={artifact().data} height={560} />
              </div>
            )}
          </Match>
          <Match when={biological()}>
            {(format) => <ScientificDataView name={props.name} text={props.text} format={format()} />}
          </Match>
          <Match when={props.viewer.kind === "html"}>
            <div class="atlas-file-html">
              <iframe class="atlas-file-html-frame" sandbox="" srcdoc={html()} title={props.name} />
            </div>
          </Match>
          <Match when={props.viewer.kind === "markdown"}>
            <MarkdownDocument name={props.name} text={props.text} />
          </Match>
          <Match when={props.viewer.kind === "table" && props.viewer.table}>
            <DataTableView text={props.text} format={props.viewer.table!} name={props.name} />
          </Match>
          <Match when={props.viewer.kind === "notebook"}>
            <NotebookDocument name={props.name} text={props.text} format={props.viewer.extension} />
          </Match>
        </Switch>
      </Suspense>
    </ErrorBoundary>
  )
}
