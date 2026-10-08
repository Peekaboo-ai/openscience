import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { ArtifactRenderProps } from "../registry"

/**
 * `genome-track` renderer — mounts an igv.js genome browser in a ref div.
 *
 * igv.js is a framework-agnostic vanilla-JS library (no React). We create the
 * browser in `onMount` via `igv.createBrowser(host, config)` and tear it down in
 * `onCleanup` with `igv.removeBrowser(browser)` (igv holds canvas/WebGL-ish DOM
 * state, so disposal matters).
 *
 * The heavy library is pulled with a dynamic `import()` so it is code-split out
 * of the main app bundle and only fetched when a genome artifact is first shown.
 *
 * Expected `props.data` (all optional — a partial config is tolerated):
 * ```
 * {
 *   genome?: string | ReferenceGenome   // e.g. "hg38", or a { fastaURL, indexURL }
 *   reference?: ReferenceGenome          // alias for a custom reference genome
 *   locus?: string | string[]           // e.g. "chr8:127,735,434-127,742,951" or "MYC"
 *   tracks?: TrackLoad[]                 // igv track configs (BAM/VCF/BED/bigWig/…)
 * }
 * ```
 */

interface GenomeTrackData {
  genome?: unknown
  reference?: unknown
  locus?: string | string[]
  tracks?: unknown[]
}

const SAMPLE: GenomeTrackData = {
  genome: "hg38",
  locus: "chr8:127,735,434-127,742,951",
}

function snapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snapshot)
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)]))
  return value
}

function normalize(data: unknown): GenomeTrackData {
  if (!data || typeof data !== "object") return {}
  const d = data as GenomeTrackData
  return {
    genome: snapshot(d.genome),
    reference: snapshot(d.reference),
    locus: Array.isArray(d.locus) ? [...d.locus] : d.locus,
    tracks: Array.isArray(d.tracks) ? d.tracks.map(snapshot) : undefined,
  }
}

interface GenomeBrowser {
  createBrowser: (div: HTMLElement, options: Record<string, unknown>) => Promise<unknown>
  removeBrowser: (browser: unknown) => void
}

interface GenomeTrackProps extends ArtifactRenderProps {
  load?: () => Promise<GenomeBrowser>
}

export function GenomeTrack(props: GenomeTrackProps) {
  // 读取传给 IGV 的配置快照，才能跟踪 store 中同一对象的参考序列、区间及轨迹更新。
  const source = createMemo(() => normalize(props.data))
  return (
    <Show when={source()} keyed>
      {(data) => <GenomeDocument data={data} height={props.height} load={props.load} />}
    </Show>
  )
}

function GenomeDocument(props: Pick<GenomeTrackProps, "height" | "load"> & { data: GenomeTrackData }) {
  let host!: HTMLDivElement
  const [error, setError] = createSignal<string>()
  const data = props.data
  const hasConfig = Boolean(data.genome || data.reference || (data.tracks && data.tracks.length))
  // Fall back to a small sample so an empty artifact still shows something useful.
  const config = hasConfig ? data : SAMPLE

  onMount(() => {
    let browser: unknown
    let library: GenomeBrowser | undefined
    let disposed = false

    ;(async () => {
      try {
        const igv = await (props.load
          ? props.load()
          : import("igv").then((module) => module.default as unknown as GenomeBrowser))
        if (disposed) return
        library = igv
        // Build the igv config. igv accepts `genome` (id or object) OR `reference`.
        const options: Record<string, unknown> = {
          showChromosomeWidget: true,
          showNavigation: true,
          showSVGButton: false,
        }
        if (config.reference) options.reference = config.reference
        else if (config.genome) options.genome = config.genome
        if (config.locus) options.locus = config.locus
        if (config.tracks && config.tracks.length) options.tracks = config.tracks

        const b = await igv.createBrowser(host, options)
        if (disposed) {
          // Component unmounted while igv was still initializing — clean up now.
          try {
            igv.removeBrowser(b)
          } catch {
            /* ignore */
          }
          return
        }
        browser = b
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    onCleanup(() => {
      disposed = true
      if (!browser) return
      try {
        library?.removeBrowser(browser)
      } catch {
        // 浏览器已被库自行销毁时，不能中断其余组件清理。
      }
    })
  })

  return (
    <div
      data-component="science-genome-track"
      style={{ position: "relative", "min-height": `${props.height ?? 460}px`, width: "100%" }}
    >
      <Show when={!hasConfig}>
        <div
          data-slot="genome-track-sample-badge"
          style={{
            position: "absolute",
            top: "6px",
            right: "8px",
            "z-index": "2",
            "font-size": "11px",
            "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
            padding: "2px 8px",
            "border-radius": "4px",
            background: "rgba(0,0,0,0.55)",
            color: "#e6e6e6",
          }}
        >
          sample · hg38 MYC locus
        </div>
      </Show>
      <Show when={error()}>
        {(msg) => (
          <div
            data-slot="genome-track-error"
            style={{
              padding: "12px 14px",
              "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
              "font-size": "12px",
              color: "#b00020",
              border: "1px solid rgba(176,0,32,0.35)",
              "border-radius": "4px",
              background: "rgba(176,0,32,0.06)",
            }}
          >
            Failed to load genome browser: {msg()}
          </div>
        )}
      </Show>
      <div ref={host} data-slot="genome-track-host" style={{ width: "100%" }} />
    </div>
  )
}
