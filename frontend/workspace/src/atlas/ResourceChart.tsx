import { For, Show, createMemo, createUniqueId } from "solid-js"
import { createStore } from "solid-js/store"
import { metricPath, percentLabel } from "./compute-monitor"

type Point = { time: number; primary: number | null; secondary?: number | null; gapBefore?: boolean }
export function ResourceChart(props: {
  label: string
  points: Point[]
  minutes: number
  end: number
  secondary?: boolean
}) {
  const id = createUniqueId()
  const [state, setState] = createStore({ index: -1 })
  const start = () => props.end - props.minutes * 60_000
  const visible = createMemo(() => props.points.filter((point) => point.time >= start()))
  const path = (secondary = false) =>
    metricPath(
      visible().map((point) => ({
        time: point.time,
        value: secondary ? (point.secondary ?? null) : point.primary,
        gapBefore: point.gapBefore,
      })),
      start(),
      props.end,
    )
  const focused = () => visible()[Math.min(state.index, visible().length - 1)]
  const time = (value: number) =>
    new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  const select = (clientX: number, bounds: DOMRect) => {
    const timestamp = start() + Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)) * (props.end - start())
    const nearest = visible().reduce(
      (best, point, index, points) =>
        Math.abs(point.time - timestamp) < Math.abs(points[best].time - timestamp) ? index : best,
      0,
    )
    setState("index", nearest)
  }
  return (
    <div class="resource-chart">
      <svg
        viewBox="0 0 300 100"
        preserveAspectRatio="none"
        role="img"
        tabindex="0"
        aria-label={`${props.label}. Use the left and right arrow keys to inspect samples.`}
        aria-describedby={`${id}-reading`}
        onPointerMove={(event) => select(event.clientX, event.currentTarget.getBoundingClientRect())}
        onPointerLeave={() => setState("index", -1)}
        onBlur={() => setState("index", -1)}
        onFocus={() => setState("index", visible().length - 1)}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
          event.preventDefault()
          setState(
            "index",
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? visible().length - 1
                : Math.max(0, Math.min(visible().length - 1, state.index + (event.key === "ArrowLeft" ? -1 : 1))),
          )
        }}
      >
        <title>{props.label}</title>
        <For each={[10, 49, 88]}>{(y) => <line class="resource-chart__grid" x1="8" x2="292" y1={y} y2={y} />}</For>
        <text class="resource-chart__axis" x="8" y="8">
          100%
        </text>
        <path class="resource-chart__line" d={path()} />
        <Show when={props.secondary}>
          <path class="resource-chart__line resource-chart__line--memory" d={path(true)} />
        </Show>
        <Show when={visible().at(-1)?.primary != null}>
          <circle
            class="resource-chart__point"
            r="2.5"
            cx={8 + ((visible().at(-1)!.time - start()) / (props.end - start())) * 284}
            cy={88 - (visible().at(-1)!.primary ?? 0) * 0.78}
          />
        </Show>
        <Show when={focused()}>
          {(point) => (
            <line
              class="resource-chart__cursor"
              x1={8 + ((point().time - start()) / (props.end - start())) * 284}
              x2={8 + ((point().time - start()) / (props.end - start())) * 284}
              y1="10"
              y2="88"
            />
          )}
        </Show>
      </svg>
      <div class="resource-chart__time">
        <span>{time(start())}</span>
        <span>{time(props.end)}</span>
      </div>
      <div id={`${id}-reading`} class="resource-chart__reading" aria-live="off">
        <Show
          when={focused()}
          fallback={<span>{visible().length < 2 ? "Collecting history…" : "Hover or focus to inspect"}</span>}
        >
          {(point) => (
            <span>
              {time(point().time)} · {percentLabel(point().primary)}
              {props.secondary ? ` compute · ${percentLabel(point().secondary)} memory` : ""}
            </span>
          )}
        </Show>
      </div>
    </div>
  )
}
