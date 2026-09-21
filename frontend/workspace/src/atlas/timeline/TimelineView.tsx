import { Button } from "@synsci/ui/button"
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
import type { TimelineRecoveryPlan } from "@synsci/sdk/v2/client"
import "./timeline.css"

export type Translate = (en: string, zh: string) => string
export type TimelineViewProps = {
  sessionID: string
  active?: boolean
  data: Snapshot
  t: Translate
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
const cost = (value?: number) => (value === undefined ? "—" : `$${value.toFixed(6)}`)

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
  })
  const refs: {
    list?: HTMLDivElement
    graph?: SVGSVGElement
    drag?: { x: number; window: Window; pan: boolean }
    observer?: ResizeObserver
  } = {}
  const entries = createMemo(() => props.data.entries)
  const bounds = createMemo(() => domain(entries(), view.now))
  const window = () => view.window ?? bounds()
  const filtered = createMemo(() =>
    entries().filter(
      (entry) =>
        !view.filter ||
        (entry.startedAt !== undefined &&
          entry.startedAt <= view.filter.end &&
          (entry.completedAt ?? entry.startedAt) >= view.filter.start),
    ),
  )
  const ledger = createMemo(() => rows(filtered(), view.collapsed, view.query))
  const plotted = createMemo(() =>
    entries().filter((entry) => matches(entry, view.query) && entry.startedAt !== undefined),
  )
  const paths = createMemo(() => overviewPaths(plotted(), window(), view.now))
  const selection = createMemo(() => entries().find((entry) => entry.id === view.selected))
  const start = () => Math.max(0, Math.floor(view.scroll / ROW_HEIGHT) - 8)
  const visible = () => ledger().slice(start(), start() + Math.ceil(view.height / ROW_HEIGHT) + 16)
  const active = () => props.data.pages[0]?.status ?? "idle"
  const select = (entry: Entry) => setView("selected", view.selected === entry.id ? "" : entry.id)
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
    if (view.follow && !view.query && !view.filter && refs.list) {
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
        ? `${entry.title} · ${entry.status} · ${exact(entry.startedAt)} → ${exact(entry.completedAt)} · ${formatDuration(duration(entry, view.now))}`
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
          <p>{props.t("Execution progress, timing and recovery history", "执行进展、耗时与恢复历史")}</p>
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
              : active()}
        </span>
        <span title={props.sessionID}>
          {props.t("Session", "会话")} {props.sessionID.slice(-12)}
        </span>
        <span>
          {props.t("Loaded", "已加载")} {entries().length} · {props.data.pages[0]?.totalMessages ?? 0}{" "}
          {props.t("messages", "条消息")}
        </span>
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
          <div class="action-timeline__card">
            <label class="action-timeline__search">
              {props.t("Search loaded actions", "搜索已加载行动")}
              <input
                type="search"
                value={view.query}
                onInput={(event) => search(event.currentTarget.value)}
                placeholder={props.t("Title, type, resource, status…", "标题、类型、资源、状态…")}
              />
            </label>
            <small>
              {props.t(
                "Search covers loaded records only. Load earlier history to include it. Matching turns expand temporarily.",
                "仅搜索已加载记录；可加载更早历史。搜索时临时展开匹配的 Turn。",
              )}
            </small>
          </div>
          <section class="action-timeline__card" aria-label={props.t("Timing overview", "耗时概览")}>
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
          </section>
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
                setView({ follow: true, filter: undefined })
              }}
            >
              {props.t("Follow latest", "跟随最新")}
            </Button>
            <span>
              {ledger().filter((row) => row.type === "entry").length} {props.t("visible actions", "条可见行动")}
            </span>
          </div>
          <div class="action-timeline__columns" aria-hidden="true">
            <span>{props.t("Type / action", "类型 / 行动")}</span>
            <span>{props.t("Duration", "耗时")}</span>
            <span>Tokens</span>
            <span>{props.t("Cost", "费用")}</span>
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
                follow: node.scrollHeight - node.clientHeight - node.scrollTop <= 3 && !view.query && !view.filter,
              })
            }}
          >
            <Show when={!ledger().length}>
              <p class="action-timeline__empty">
                {props.data.loading
                  ? props.t("Loading actions…", "正在加载行动…")
                  : view.query || view.filter
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
                          {view.collapsed[row.id] && !view.query ? "▸" : "▾"} TURN · {row.id.slice(-8)} ·{" "}
                          {row.type === "turn" ? row.count : 0}
                        </Button>
                      }
                    >
                      {(entry) => (
                        <Button
                          size="small"
                          variant="ghost"
                          class="action-timeline__entry"
                          aria-pressed={view.selected === entry().id}
                          onClick={() => select(entry())}
                          data-status={entry().status}
                          title={`${entry().title} · ${entry().status}`}
                        >
                          <span>
                            <small>
                              {entry().kind} · {entry().status}
                            </small>
                            <strong>{entry().title}</strong>
                          </span>
                          <span>{formatDuration(duration(entry(), view.now))}</span>
                          <span>{tokenTotal(entry())?.toLocaleString() ?? "—"}</span>
                          <span>{cost(entry().cost)}</span>
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
              <section
                class="action-timeline__card action-timeline__details"
                aria-label={props.t("Action details", "行动详情")}
              >
                <div class="action-timeline__heading">
                  <strong>{entry().title}</strong>
                  <Button size="small" variant="ghost" onClick={() => setView("selected", "")}>
                    {props.t("Close details", "关闭详情")}
                  </Button>
                </div>
                <dl>
                  <dt>ID</dt>
                  <dd>{entry().id}</dd>
                  <dt>{props.t("Status", "状态")}</dt>
                  <dd>{entry().status}</dd>
                  <dt>{props.t("Owner", "执行者")}</dt>
                  <dd>{entry().owner}</dd>
                  <dt>{props.t("Cost", "费用")}</dt>
                  <dd>{cost(entry().cost)}</dd>
                  <dt>{props.t("Started", "开始")}</dt>
                  <dd>{exact(entry().startedAt)}</dd>
                  <dt>{props.t("First response", "首响应")}</dt>
                  <dd>{exact(entry().responseAt)}</dd>
                  <dt>{props.t("Finished", "结束")}</dt>
                  <dd>{exact(entry().completedAt)}</dd>
                  <dt>{props.t("Resources", "资源")}</dt>
                  <dd>{entry().resources.join(", ") || "—"}</dd>
                  <dt>{props.t("Artifacts", "制品")}</dt>
                  <dd>{entry().artifacts.join(", ") || "—"}</dd>
                </dl>
                <Show when={entry().tokens}>
                  {(tokens) => (
                    <p>
                      Input {tokens().input} · Output {tokens().output} · Reasoning {tokens().reasoning} · Cache{" "}
                      {tokens().cacheRead}/{tokens().cacheWrite}
                    </p>
                  )}
                </Show>
                <Show when={entry().executionID}>
                  <dl>
                    <dt>{props.t("Execution", "执行")}</dt>
                    <dd>{entry().executionID}</dd>
                    <dt>{props.t("Queued", "入队")}</dt>
                    <dd>{exact(entry().queuedAt)}</dd>
                    <dt>{props.t("Generation", "代次")}</dt>
                    <dd>{entry().generation ?? "—"}</dd>
                  </dl>
                </Show>
                <Show when={entry().error}>
                  <p class="action-timeline__error">{entry().error}</p>
                </Show>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={!!props.mutation || active() !== "idle"}
                  onClick={() => props.fork(entry().messageID)}
                >
                  {props.t("Fork before this message", "从此消息之前分支")}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={!!props.mutation || active() !== "idle" || !!props.data.error}
                  onClick={() => props.revert(entry().messageID)}
                >
                  {props.t("Undo from this message", "从此消息撤销")}
                </Button>
                <Show when={entry().childSessionID}>
                  {(id) => (
                    <Button size="small" variant="ghost" onClick={() => props.openSession(id())}>
                      {props.t("Open child session", "打开子会话")}
                    </Button>
                  )}
                </Show>
              </section>
            )}
          </Show>
        </main>
        <TimelineWorkbenchView {...props} />
      </div>
    </section>
  )
}
