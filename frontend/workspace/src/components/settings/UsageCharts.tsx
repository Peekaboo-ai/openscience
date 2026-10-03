import { For, Show, createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { formatTokens, USAGE_SERIES, type UsageReport } from "./usage-stats"

export function usageDate(value: string, full = false) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    month: full ? "long" : "short",
    day: "numeric",
    ...(full ? { year: "numeric" } : {}),
  }).format(new Date(`${value}T12:00:00Z`))
}

export function AnimatedUsage(props: { value: number; format?: (value: number) => string }) {
  const [state, setState] = createStore({ value: props.value })
  let frame = 0
  createEffect(() => {
    const target = props.value
    const start = untrack(() => state.value)
    if (typeof requestAnimationFrame !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setState("value", target)
      return
    }
    const at = performance.now()
    const animate = (time: number) => {
      const progress = Math.min(1, (time - at) / 420)
      setState("value", start + (target - start) * (1 - (1 - progress) ** 3))
      if (progress < 1) frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    onCleanup(() => cancelAnimationFrame(frame))
  })
  return <>{props.format ? props.format(state.value) : formatTokens(Math.round(state.value))}</>
}

export function UsageBreakdown(props: { tokens: UsageReport["totals"]["tokens"]; reasoning?: boolean }) {
  return (
    <dl class="usage-breakdown">
      <For each={USAGE_SERIES}>
        {(series) => (
          <div>
            <dt>
              <i class="usage-dot" data-usage-color={series.color} />
              {series.label}
            </dt>
            <dd title={formatTokens(props.tokens[series.key], false)}>{formatTokens(props.tokens[series.key])}</dd>
          </div>
        )}
      </For>
      <Show when={props.reasoning}>
        <div>
          <dt>Reasoning (in output)</dt>
          <dd>{formatTokens(props.tokens.reasoning)}</dd>
        </div>
      </Show>
    </dl>
  )
}

export function UsageTrend(props: { report: UsageReport }) {
  const [state, setState] = createStore({ hover: -1 })
  const maximum = createMemo(() => Math.max(1, ...props.report.trend.map((point) => point.total)))
  const focused = () => props.report.trend[state.hover]
  const axis = (value: number) => formatTokens(value)
  return (
    <section class="usage-section" aria-label="Usage trend">
      <div class="usage-section-head">
        <h3>Usage trend</h3>
        <span class="usage-meta">
          {props.report.interval === "day" ? "Daily" : props.report.interval === "week" ? "Weekly" : "Monthly"} tokens
        </span>
      </div>
      <div class="usage-chart" onMouseLeave={() => setState("hover", -1)}>
        <div class="usage-chart__axis" aria-hidden="true">
          <span>{axis(maximum())}</span>
          <span>{axis(maximum() / 2)}</span>
          <span>0</span>
        </div>
        <div
          class="usage-chart__plot"
          role="group"
          aria-label={`${props.report.interval === "day" ? "Daily" : props.report.interval === "week" ? "Weekly" : "Monthly"} tokens`}
          style={{ "grid-template-columns": `repeat(${props.report.trend.length}, minmax(0, 1fr))` }}
        >
          <For each={props.report.trend}>
            {(point, index) => {
              const value = () => point.total
              return (
                <button
                  type="button"
                  class="usage-chart__bar"
                  aria-label={`${usageDate(point.date, true)}${point.date !== point.end ? ` to ${usageDate(point.end, true)}` : ""}: ${formatTokens(point.total, false)} tokens, ${point.requests} requests`}
                  onMouseEnter={() => setState("hover", index())}
                  onFocus={() => setState("hover", index())}
                  onBlur={() => setState("hover", -1)}
                  onClick={() => setState("hover", index())}
                  onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
                    event.preventDefault()
                    const target =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? props.report.trend.length - 1
                          : Math.max(
                              0,
                              Math.min(props.report.trend.length - 1, index() + (event.key === "ArrowLeft" ? -1 : 1)),
                            )
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[target]?.focus()
                  }}
                >
                  <span
                    class="usage-chart__stack"
                    style={{ transform: `scaleY(${value() / maximum()})` }}
                    aria-hidden="true"
                  >
                    <For each={USAGE_SERIES}>
                      {(series) => (
                        <span
                          data-usage-color={series.color}
                          style={{ height: `${point.total > 0 ? (point.tokens[series.key] / point.total) * 100 : 0}%` }}
                        />
                      )}
                    </For>
                  </span>
                </button>
              )
            }}
          </For>
        </div>
        <div class="usage-chart__dates" data-single={props.report.trend.length === 1} aria-hidden="true">
          <span>{usageDate(props.report.from)}</span>
          <Show when={props.report.trend.length > 1}>
            <span>
              {usageDate(props.report.trend[Math.floor(props.report.trend.length / 2)]?.date ?? props.report.from)}
            </span>
            <span>{usageDate(props.report.to)}</span>
          </Show>
        </div>
        <Show when={focused()}>
          {(point) => (
            <div class="usage-chart__tooltip" role="status">
              <strong>
                {usageDate(point().date)}
                {point().date !== point().end ? ` - ${usageDate(point().end)}` : ""}
              </strong>
              <span>
                Tokens <b>{formatTokens(point().total, false)}</b>
              </span>
              <For each={USAGE_SERIES}>
                {(series) => (
                  <span>
                    {series.label}
                    <span>{formatTokens(point().tokens[series.key])}</span>
                  </span>
                )}
              </For>
              <span>
                Requests <span>{point().requests}</span>
              </span>
            </div>
          )}
        </Show>
      </div>
      <div class="usage-legend">
        <For each={USAGE_SERIES}>
          {(series) => (
            <span>
              <i class="usage-dot" data-usage-color={series.color} />
              {series.label}
            </span>
          )}
        </For>
      </div>
    </section>
  )
}

export function UsageActivity(props: { report: UsageReport; onDay: (date: string) => void }) {
  const [state, setState] = createStore({ date: "" })
  const padding = () =>
    props.report.activity.length ? new Date(`${props.report.activity[0].date}T00:00:00Z`).getUTCDay() : 0
  const hovered = () => props.report.activity.find((item) => item.date === state.date)
  return (
    <section class="usage-section" aria-label="Activity">
      <div class="usage-section-head">
        <h3>Activity</h3>
        <span class="usage-meta">
          {props.report.activeDays} active day{props.report.activeDays === 1 ? "" : "s"}
        </span>
      </div>
      <div class="usage-heatmap-scroll" onMouseLeave={() => setState("date", "")}>
        <div class="usage-heatmap" role="group" aria-label="Daily token activity">
          <For each={Array.from({ length: padding() })}>
            {() => <span class="usage-heatmap__blank" aria-hidden="true" />}
          </For>
          <For each={props.report.activity}>
            {(item) => (
              <button
                type="button"
                data-level={item.level}
                title={`${usageDate(item.date, true)}: ${formatTokens(item.total, false)} tokens, ${item.requests} requests`}
                aria-label={`${usageDate(item.date, true)}: ${formatTokens(item.total, false)} tokens, ${item.requests} requests`}
                onMouseEnter={() => setState("date", item.date)}
                onFocus={() => setState("date", item.date)}
                onBlur={() => setState("date", "")}
                onClick={() => props.onDay(item.date)}
              />
            )}
          </For>
        </div>
      </div>
      <div class="usage-footer">
        <span class="usage-caption" role="status">
          {hovered()
            ? `${usageDate(hovered()!.date)} / ${formatTokens(hovered()!.total)} tokens`
            : `${usageDate(props.report.activity[0]?.date ?? props.report.from)} - ${usageDate(props.report.to)}`}
        </span>
        <div class="usage-heatmap__legend" aria-hidden="true">
          <span>Less</span>
          <For each={[0, 25, 45, 70, 100]}>
            {(level) => (
              <i
                style={{
                  background: level
                    ? `color-mix(in srgb, var(--usage-output) ${level}%, var(--settings-canvas))`
                    : "var(--settings-surface-muted)",
                }}
              />
            )}
          </For>
          <span>More</span>
        </div>
      </div>
    </section>
  )
}
