import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { For, Show, createEffect, createMemo, onCleanup, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { Snapshot } from "./controller"
import {
  domain,
  duration,
  formatDuration,
  matches,
  overviewPaths,
  pan,
  ROW_HEIGHT,
  rows,
  tokenTotal,
  zoom,
  type Entry,
  type Window,
} from "./model"
import { TimelineWorkbenchView } from "./WorkbenchView"
import { ActionDetails } from "./ActionDetails"
import { present, requestTitle, statusLabel, type Catalog, type Translate } from "./presentation"
import type { TimelineRecoveryPlan } from "@synsci/sdk/v2/client"
import "./timeline.css"

export type { Translate } from "./presentation"
export type TimelineViewProps = {
  sessionID: string
  active?: boolean
  data: Snapshot
  t: Translate
  catalog?: Catalog
  mutation?: string
  actionError?: string
  refresh: () => void
  earlier: () => Promise<void>
  checkpoint: () => void
  fork: (messageID?: string) => void
  openSession: (sessionID: string) => void
  openCheckpoint: (path: string) => void
  restart: (kernelID: string) => void
  revert: (messageID: string) => void
  restore: () => void
  cancelRun?: (runID: string) => void
  cancelJob?: (jobID: string) => void
  childControl?: (childID: string, operation: "stop" | "steer") => void
  recoveryPlan?: TimelineRecoveryPlan
  previewRecovery?: (checkpointID: string) => void
  recover?: (checkpointID: string) => void
  forkCheckpoint?: (checkpointID: string) => void
}

const exact = (value?: number) => (value === undefined ? "—" : new Date(value).toISOString().replace("T", " "))

export function TimelineView(props: TimelineViewProps): JSX.Element {
  const [view, setView] = createStore({
    query: "",
    collapsed: {} as Record<string, boolean>,
    selected: "",
    hover: "",
    scroll: 0,
    height: 460,
    now: Date.now(),
    window: undefined as Window | undefined,
    filter: undefined as Window | undefined,
    follow: true,
    issuesOnly: false,
  })
  const refs: {
    list?: HTMLDivElement
    graph?: SVGSVGElement
    drag?: { x: number; window: Window; pan: boolean }
    observer?: ResizeObserver
    details?: HTMLElement
  } = {}
  const entries = createMemo(() => props.data.entries)
  const labels = createMemo(() => new Map(entries().map((entry) => [entry.id, present(entry, props.t, props.catalog)])))
  const label = (entry: Entry) => labels().get(entry.id)!
  const searchable = (entry: Entry) => {
    const item = label(entry)
    return `${item.title} ${item.subtitle} ${item.status}`
  }
  const issues = createMemo(() =>
    entries().filter((entry) => ["error", "partial", "interrupted"].includes(entry.status)),
  )
  const bounds = createMemo(() => domain(entries(), view.now))
  const window = () => view.window ?? bounds()
  const filtered = createMemo(() =>
    entries().filter(
      (entry) =>
        (!view.issuesOnly || ["error", "partial", "interrupted"].includes(entry.status)) &&
        (!view.filter ||
          (entry.startedAt !== undefined &&
            entry.startedAt <= view.filter.end &&
            (entry.completedAt ?? (entry.status === "running" ? view.now : entry.startedAt)) >= view.filter.start)),
    ),
  )
  const ledger = createMemo(() => rows(filtered(), view.collapsed, view.query, searchable, entries()))
  const plotted = createMemo(() =>
    entries().filter((entry) => matches(entry, view.query, searchable(entry)) && entry.startedAt !== undefined),
  )
  const paths = createMemo(() => overviewPaths(plotted(), window(), view.now))
  const selection = createMemo(() => entries().find((entry) => entry.id === view.selected))
  const start = () => Math.max(0, Math.floor(view.scroll / ROW_HEIGHT) - 8)
  const visible = () => ledger().slice(start(), start() + Math.ceil(view.height / ROW_HEIGHT) + 16)
  const active = () => props.data.pages[0]?.status ?? "idle"
  const select = (entry: Entry) => {
    setView("selected", view.selected === entry.id ? "" : entry.id)
    if (view.selected) queueMicrotask(() => refs.details?.scrollIntoView?.({ block: "nearest" }))
  }
  const reset = () => setView({ window: undefined, filter: undefined })
  const x = (time: number) => ((time - window().start) / (window().end - window().start)) * 1000

  onMount(() => {
    const timer = setInterval(() => {
      if (props.active !== false && !document.hidden && entries().some((entry) => entry.status === "running"))
        setView("now", Date.now())
    }, 1000)
    if (typeof ResizeObserver !== "undefined" && refs.list) {
      refs.observer = new ResizeObserver(() => setView("height", refs.list?.clientHeight || 460))
      refs.observer.observe(refs.list)
    }
    onCleanup(() => {
      clearInterval(timer)
      refs.observer?.disconnect()
    })
  })
  createEffect(() => {
    const length = ledger().length
    if (view.follow && !view.query && !view.filter && !view.issuesOnly && refs.list) {
      const target = Math.max(0, length * ROW_HEIGHT - view.height)
      refs.list.scrollTop = target
      setView("scroll", target)
    }
  })
  createEffect(() => {
    if (view.selected && !selection()) setView("selected", "")
  })

  const search = (value: string) => {
    setView({ query: value, scroll: 0, follow: false })
    if (refs.list) refs.list.scrollTop = 0
  }
  const earlier = async () => {
    const prior = ledger().length
    const scroll = refs.list?.scrollTop ?? 0
    setView("follow", false)
    await props.earlier()
    const offset = Math.max(0, ledger().length - prior) * ROW_HEIGHT
    if (refs.list) refs.list.scrollTop = scroll + offset
    setView("scroll", scroll + offset)
  }
  const dragStart = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 2) return
    refs.drag = { x: event.clientX, window: { ...window() }, pan: event.button === 2 || event.shiftKey }
    refs.graph?.setPointerCapture(event.pointerId)
  }
  const dragMove = (event: PointerEvent) => {
    const rect = refs.graph?.getBoundingClientRect()
    const entry = rect
      ? plotted()[Math.floor(((event.clientY - rect.top) / rect.height) * plotted().length)]
      : undefined
    setView(
      "hover",
      entry
        ? `${label(entry).title} · ${label(entry).status} · ${exact(entry.startedAt)} → ${exact(entry.completedAt)} · ${formatDuration(duration(entry, view.now))}`
        : "",
    )
    if (!refs.drag?.pan) return
    const width = refs.graph?.getBoundingClientRect().width || 1
    setView("window", pan(refs.drag.window, (refs.drag.x - event.clientX) / width))
  }
  const dragEnd = (event: PointerEvent) => {
    const drag = refs.drag
    refs.drag = undefined
    if (!drag || drag.pan) return
    if (Math.abs(event.clientX - drag.x) < 8) {
      const rect = refs.graph?.getBoundingClientRect()
      const entry = rect
        ? plotted()[Math.floor(((event.clientY - rect.top) / rect.height) * plotted().length)]
        : undefined
      if (entry) select(entry)
      return
    }
    const rect = refs.graph!.getBoundingClientRect()
    const convert = (point: number) =>
      drag.window.start +
      Math.min(1, Math.max(0, (point - rect.left) / rect.width)) * (drag.window.end - drag.window.start)
    setView({
      filter: { start: convert(Math.min(event.clientX, drag.x)), end: convert(Math.max(event.clientX, drag.x)) },
      follow: false,
      scroll: 0,
    })
    if (refs.list) refs.list.scrollTop = 0
  }
  const listKeys = (event: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)) return
    event.preventDefault()
    const current = Number(
      (event.target as HTMLElement).closest<HTMLElement>("[data-row-index]")?.dataset.rowIndex ??
        Math.floor(view.scroll / ROW_HEIGHT),
    )
    const step = Math.max(1, Math.floor(view.height / ROW_HEIGHT))
    const next = Math.max(
      0,
      Math.min(
        ledger().length - 1,
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? ledger().length - 1
            : current +
              (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "PageDown" ? step : -step),
      ),
    )
    setView({ follow: false, scroll: next * ROW_HEIGHT })
    if (refs.list) refs.list.scrollTop = next * ROW_HEIGHT
    queueMicrotask(() =>
      refs.list?.querySelector<HTMLButtonElement>(`[data-row-index="${next}"] button`)?.focus({ preventScroll: true }),
    )
  }

  return (
    <section class="action-timeline" aria-label={props.t("Action Timeline", "行动时间线")}>
      <header class="action-timeline__heading">
        <div>
          <h2>{props.t("Action Timeline", "行动时间线")}</h2>
          <p>
            {props.t(
              "Model responses and execution steps, grouped by research request.",
              "按研究请求，追踪模型响应与执行步骤。",
            )}
          </p>
        </div>
        <Button size="small" variant="ghost" disabled={props.data.loading} onClick={props.refresh}>
          {props.t("Refresh", "刷新")}
        </Button>
      </header>
      <div class="action-timeline__status" role="status">
        <span
          class="action-timeline__badge"
          data-status={props.data.error ? "error" : active() === "idle" ? "completed" : "running"}
        >
          {props.data.error
            ? props.t("Disconnected", "连接异常")
            : props.data.loading
              ? props.t("Updating…", "更新中…")
              : statusLabel(active(), props.t)}
        </span>
        <span>
          {new Set(entries().map((entry) => entry.turnID)).size} {props.t("requests", "次请求")} ·{" "}
          {entries().filter((entry) => entry.kind !== "user").length} {props.t("steps loaded", "个已加载步骤")}
        </span>
        <Show when={issues().length}>
          <span class="action-timeline__badge" data-status="partial">
            {issues().length} {props.t("need review", "项待检查")}
          </span>
        </Show>
        <Show when={props.data.updatedAt}>
          <span title={exact(props.data.updatedAt)}>
            {props.t("Updated", "更新于")} {new Date(props.data.updatedAt!).toLocaleTimeString()}
          </span>
        </Show>
      </div>
      <Show when={props.data.error}>
        <p class="action-timeline__error" role="alert">
          {props.data.error} {props.t("Showing the last successful snapshot.", "当前显示上次成功读取的快照。")}
        </p>
      </Show>
      <Show when={props.actionError}>
        <p class="action-timeline__error" role="alert">
          {props.actionError}
        </p>
      </Show>
      <div class="action-timeline__layout">
        <main class="action-timeline__main">
          <details class="action-timeline__definition">
            <summary>{props.t("What counts as an action?", "什么是行动？")}</summary>
            <p>
              {props.t(
                "An action is an observable step taken to carry out a request: a model response, tool call, analysis, retry or context update. Requests group these steps; one step may have its own recorded execution attempt. Completion describes the step, not the scientific validity of its result.",
                "行动是完成请求时可观察到的一个步骤，如模型响应、工具调用、计算分析、重试或上下文更新。请求将这些步骤组织在一起；具体执行可有独立的执行记录。步骤完成不代表科研结论已经验证。",
              )}
            </p>
          </details>
          <div class="action-timeline__search-area">
            <label class="action-timeline__search">
              <span class="action-timeline__sr-only">{props.t("Search loaded actions", "搜索已加载行动")}</span>
              <input
                type="search"
                value={view.query}
                onInput={(event) => search(event.currentTarget.value)}
                placeholder={props.t("Request, action, model or status…", "搜索请求、行动、模型或状态…")}
              />
            </label>
            <small>
              {props.t(
                "Search covers loaded records only. Load earlier history to include it. Matching turns expand temporarily.",
                "仅搜索已加载记录；匹配的请求将临时展开。",
              )}
            </small>
          </div>
          <details class="action-timeline__card action-timeline__timing">
            <summary>{props.t("Timing overview & time filter", "耗时概览与时间筛选")}</summary>
            <div class="action-timeline__legend">
              <strong>{props.t("Timing overview", "耗时概览")}</strong>
              <span data-phase="response">{props.t("First response", "首响应")}</span>
              <span data-phase="decode">{props.t("Remaining response", "后续响应")}</span>
              <span data-phase="execution">{props.t("Execution", "执行")}</span>
            </div>
            <small>
              {props.t(
                "Drag to filter · wheel to zoom · Shift/right drag to pan. Missing phases are not estimated.",
                "拖选过滤 · 滚轮缩放 · Shift/右键拖移。未记录的阶段不作估算。",
              )}
            </small>
            <svg
              ref={(element) => {
                refs.graph = element
              }}
              viewBox="0 0 1000 160"
              preserveAspectRatio="none"
              role="img"
              aria-label={props.t(
                "Action durations; use controls below to zoom and pan",
                "行动耗时；可使用下方按钮缩放和平移",
              )}
              class="action-timeline__graph"
              onWheel={(event) => {
                event.preventDefault()
                const rect = event.currentTarget.getBoundingClientRect()
                setView(
                  "window",
                  zoom(window(), event.deltaY > 0 ? 1.25 : 0.8, (event.clientX - rect.left) / rect.width),
                )
              }}
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={dragStart}
              onPointerMove={dragMove}
              onPointerUp={dragEnd}
              onPointerCancel={() => {
                refs.drag = undefined
              }}
            >
              <title>
                {view.hover || props.t("Select an action below for exact timings.", "选择下方行动查看精确时刻。")}
              </title>
              <For each={paths()}>{(item) => <path data-phase={item.phase} d={item.path} />}</For>
              <Show when={view.filter}>
                {(filter) => (
                  <rect
                    class="action-timeline__selection"
                    x={x(filter().start)}
                    y="0"
                    width={x(filter().end) - x(filter().start)}
                    height="160"
                  />
                )}
              </Show>
            </svg>
            <div class="action-timeline__graph-controls">
              <time title={exact(window().start)}>{new Date(window().start).toLocaleTimeString()}</time>
              <Button
                size="small"
                variant="ghost"
                aria-label={props.t("Pan earlier", "向前平移")}
                onClick={() => setView("window", pan(window(), -0.25))}
              >
                ←
              </Button>
              <Button
                size="small"
                variant="ghost"
                aria-label={props.t("Zoom out", "缩小")}
                onClick={() => setView("window", zoom(window(), 1.5))}
              >
                −
              </Button>
              <Button
                size="small"
                variant="ghost"
                aria-label={props.t("Zoom in", "放大")}
                onClick={() => setView("window", zoom(window(), 0.67))}
              >
                +
              </Button>
              <Button
                size="small"
                variant="ghost"
                aria-label={props.t("Pan later", "向后平移")}
                onClick={() => setView("window", pan(window(), 0.25))}
              >
                →
              </Button>
              <Button size="small" variant="ghost" onClick={reset}>
                {props.t("Reset", "重置")}
              </Button>
              <time title={exact(window().end)}>{new Date(window().end).toLocaleTimeString()}</time>
            </div>
            <Show when={view.filter}>
              <Button size="small" variant="ghost" onClick={() => setView("filter", undefined)}>
                {props.t("Clear time filter", "清除时间过滤")}
              </Button>
            </Show>
            <details class="action-timeline__time-filter">
              <summary>{props.t("Filter by exact time (UTC)", "按精确时间过滤（UTC）")}</summary>
              <For each={["start", "end"] as const}>
                {(edge) => (
                  <label>
                    {edge === "start" ? props.t("From", "开始") : props.t("Until", "结束")}
                    <input
                      type="datetime-local"
                      step="0.001"
                      value={new Date((view.filter ?? window())[edge]).toISOString().slice(0, -1)}
                      onChange={(event) => {
                        const value = Date.parse(`${event.currentTarget.value}Z`)
                        if (!Number.isFinite(value)) return
                        const range = { ...(view.filter ?? window()), [edge]: value }
                        if (range.end < range.start) return
                        setView({ filter: range, follow: false, scroll: 0 })
                        if (refs.list) refs.list.scrollTop = 0
                      }}
                    />
                  </label>
                )}
              </For>
            </details>
          </details>
          <div class="action-timeline__ledger-controls">
            <Button
              size="small"
              variant="ghost"
              onClick={() => void earlier()}
              disabled={props.data.loading || !props.data.pages.at(-1)?.hasEarlier}
            >
              {props.t("Load earlier", "加载更早记录")}
            </Button>
            <Button
              size="small"
              variant="ghost"
              aria-pressed={view.follow}
              onClick={() => {
                search("")
                setView({ follow: true, filter: undefined, issuesOnly: false })
              }}
            >
              {props.t("Follow latest", "跟随最新")}
            </Button>
            <Button
              size="small"
              variant="ghost"
              aria-pressed={view.issuesOnly}
              onClick={() => {
                setView({ issuesOnly: !view.issuesOnly, follow: false, scroll: 0 })
                if (refs.list) refs.list.scrollTop = 0
              }}
            >
              {props.t("Needs review", "仅看待检查")}
            </Button>
            <span>
              {ledger().filter((row) => row.type === "entry").length} {props.t("visible records", "条可见记录")}
            </span>
          </div>
          <div class="action-timeline__columns" aria-hidden="true">
            <span>{props.t("Request / execution step", "研究请求 / 执行步骤")}</span>
            <span>{props.t("Duration", "耗时")}</span>
            <span class="action-timeline__tokens">{props.t("Tokens", "Token 用量")}</span>
          </div>
          <div
            ref={(element) => {
              refs.list = element
            }}
            class="action-timeline__ledger"
            role="list"
            aria-label={props.t("Action ledger", "行动记录")}
            tabindex="0"
            onKeyDown={listKeys}
            onScroll={(event) => {
              const node = event.currentTarget
              setView({
                scroll: node.scrollTop,
                follow:
                  node.scrollHeight - node.clientHeight - node.scrollTop <= 3 &&
                  !view.query &&
                  !view.filter &&
                  !view.issuesOnly,
              })
            }}
          >
            <Show when={!ledger().length}>
              <p class="action-timeline__empty">
                {props.data.loading
                  ? props.t("Loading actions…", "正在加载行动…")
                  : view.query || view.filter || view.issuesOnly
                    ? props.t("No matching actions.", "没有匹配的行动。")
                    : props.t("No actions recorded in this session yet.", "此会话尚无行动记录。")}
              </p>
            </Show>
            <div style={{ height: `${ledger().length * ROW_HEIGHT}px`, position: "relative" }}>
              <For each={visible()}>
                {(row, index) => (
                  <div
                    role="listitem"
                    data-row-index={start() + index()}
                    aria-posinset={start() + index() + 1}
                    aria-setsize={ledger().length}
                    class="action-timeline__row"
                    style={{ top: `${(start() + index()) * ROW_HEIGHT}px` }}
                  >
                    <Show
                      when={row.type === "entry" ? row.entry : undefined}
                      fallback={
                        <Button
                          size="small"
                          variant="ghost"
                          class="action-timeline__turn"
                          aria-expanded={!view.collapsed[row.id] || !!view.query}
                          onClick={() => setView("collapsed", row.id, !view.collapsed[row.id])}
                        >
                          <Icon
                            name={view.collapsed[row.id] && !view.query ? "chevron-right" : "chevron-down"}
                            size="small"
                          />
                          <Show when={row.type === "turn" ? row : undefined}>
                            {(turn) => (
                              <>
                                <span class="action-timeline__turn-copy">
                                  <strong title={requestTitle(turn().request, props.t)}>
                                    {requestTitle(turn().request, props.t)}
                                  </strong>
                                  <small>
                                    {turn().startedAt === undefined
                                      ? props.t("Time not recorded", "未记录时间")
                                      : new Date(turn().startedAt!).toLocaleString()}
                                    {" · "}
                                    {turn().count} {props.t("steps", "个步骤")}
                                    <Show when={!turn().request}>
                                      {" · "}
                                      {props.t("Request in earlier history", "请求位于更早记录")}
                                    </Show>
                                  </small>
                                </span>
                                <Show when={turn().issues || turn().active}>
                                  <span
                                    class="action-timeline__badge"
                                    data-status={turn().active ? "running" : "partial"}
                                  >
                                    {turn().active
                                      ? props.t("Running", "执行中")
                                      : `${turn().issues} ${props.t("to review", "项待检查")}`}
                                  </span>
                                </Show>
                              </>
                            )}
                          </Show>
                        </Button>
                      }
                    >
                      {(entry) => (
                        <Button
                          size="small"
                          variant="ghost"
                          class="action-timeline__entry"
                          aria-pressed={view.selected === entry().id}
                          aria-expanded={view.selected === entry().id}
                          aria-controls={view.selected === entry().id ? "timeline-action-details" : undefined}
                          onClick={() => select(entry())}
                          data-status={entry().status}
                          title={`${label(entry()).title} · ${label(entry()).subtitle} · ${label(entry()).status}`}
                          aria-label={`${label(entry()).title} · ${label(entry()).subtitle} · ${label(entry()).status}`}
                        >
                          <span class="action-timeline__action">
                            <span class="action-timeline__action-icon" data-kind={entry().kind}>
                              <Icon name={label(entry()).icon} size="normal" />
                            </span>
                            <span class="action-timeline__action-copy">
                              <span class="action-timeline__action-title">
                                <strong>{label(entry()).title}</strong>
                                <span class="action-timeline__badge" data-status={entry().status}>
                                  {label(entry()).status}
                                </span>
                              </span>
                              <small>
                                {row.type === "entry" && row.ordinal > 0
                                  ? `${props.t("Step", "步骤")} ${row.ordinal} · `
                                  : ""}
                                {label(entry()).subtitle}
                              </small>
                            </span>
                          </span>
                          <span>{formatDuration(duration(entry(), view.now))}</span>
                          <span class="action-timeline__tokens" title={tokenTotal(entry())?.toLocaleString()}>
                            {tokenTotal(entry()) === undefined
                              ? "—"
                              : new Intl.NumberFormat(undefined, {
                                  notation: "compact",
                                  maximumFractionDigits: 1,
                                }).format(tokenTotal(entry())!)}
                          </span>
                        </Button>
                      )}
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
          <Show when={selection()}>
            {(entry) => (
              <div
                ref={(element) => {
                  refs.details = element
                }}
              >
                <ActionDetails {...props} entry={entry()} now={view.now} close={() => setView("selected", "")} />
              </div>
            )}
          </Show>
        </main>
        <details class="action-timeline__management" open={!!props.recoveryPlan || !!props.data.workbenchError}>
          <summary>
            {props.t("Session controls & recovery", "会话管理与恢复")}
            <small>
              {props.t("Checkpoints, branches, kernels, jobs and context", "检查点、分支、内核、计算任务与上下文")}
            </small>
          </summary>
          <TimelineWorkbenchView {...props} />
        </details>
      </div>
    </section>
  )
}
