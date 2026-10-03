import { For, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { Tooltip } from "@synsci/ui/tooltip"
import { useDialog } from "@synsci/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { FilterMenu, PanelBody, PanelHeader, PanelScroll, SearchInput } from "./_shared"
import { SettingsApiError, settingsApi } from "./api"
import { AnimatedUsage, UsageActivity, UsageBreakdown, UsageTrend, usageDate } from "./UsageCharts"
import {
  formatTokens,
  usageChange,
  usageCSV,
  usagePath,
  validUsageRange,
  USAGE_RANGES,
  USAGE_SERIES,
  type UsageGroup,
  type UsageQuery,
  type UsageReport,
} from "./usage-stats"
import "./usage-stats.css"

type Services = {
  sdk: Pick<ReturnType<typeof useGlobalSDK>, "url">
  platform: Pick<ReturnType<typeof usePlatform>, "fetch">
  label?: string
  providers?: Record<string, string>
  openSession?: (projectID: string, sessionID: string) => void
}
type Grouping = "models" | "projects" | "sessions"
type Sort = "total" | "requests" | "label"
const PAGE_SIZE = 8

export function UsageStats(props: { services?: Services } = {}) {
  const sdk = props.services?.sdk ?? useGlobalSDK()
  const platform = props.services?.platform ?? usePlatform()
  const server = props.services ? undefined : useServer()
  const sync = props.services ? undefined : useGlobalSync()
  const navigate = props.services ? undefined : useNavigate()
  const dialog = props.services ? undefined : useDialog()
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const today = new Date()
  const localDate = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
  const [state, setState] = createStore<{
    query: UsageQuery
    report?: UsageReport
    busy: boolean
    error?: string
    exportError?: string
    group: Grouping
    search: string
    sort: Sort
    ascending: boolean
    page: number
    expanded?: string
  }>({
    query: {
      range: "30d",
      from: localDate(new Date(today.getTime() - 29 * 86_400_000)),
      to: localDate(today),
      project: "",
      provider: "",
      model: "",
    },
    busy: true,
    group: "models",
    search: "",
    sort: "total",
    ascending: false,
    page: 0,
  })
  let root: HTMLDivElement | undefined
  let request = 0
  let abort: AbortController | undefined
  let disposed = false
  let loadedServer: string | undefined
  const label = () => props.services?.label ?? server?.name ?? sdk.url
  const providerLabel = (id: string) =>
    props.services?.providers?.[id] ?? sync?.data.provider.all.find((provider) => provider.id === id)?.name ?? id
  const secondary = (row: UsageGroup) => (state.group === "models" ? providerLabel(row.secondary) : row.secondary)
  const valid = () => validUsageRange(state.query)
  const hasFilters = () => !!(state.query.project || state.query.provider || state.query.model)
  const visible = () => !document.hidden && !root?.closest("[data-settings-panel][hidden]")
  const load = async (path: string, base: string) => {
    const id = ++request
    abort?.abort()
    const current = new AbortController()
    abort = current
    setState({ busy: true, error: undefined })
    await settingsApi<UsageReport>(base, platform.fetch ?? fetch, path, {
      signal: AbortSignal.any([current.signal, AbortSignal.timeout(30_000)]),
    })
      .then((report) => {
        if (disposed || id !== request) return
        setState("report", reconcile(report))
      })
      .catch((error: unknown) => {
        if (disposed || id !== request || current.signal.aborted) return
        setState(
          "error",
          error instanceof SettingsApiError && error.status === 404
            ? "Usage Stats is unavailable on this server. Its backend needs an update."
            : "Could not load usage for this server. Check the connection and retry.",
        )
      })
      .finally(() => {
        if (!disposed && id === request) setState("busy", false)
      })
  }
  const refresh = () => {
    if (valid()) void load(usagePath(state.query, zone, true), sdk.url)
  }
  createEffect(() => {
    const path = usagePath(state.query, zone)
    const base = sdk.url
    if (loadedServer !== base) {
      loadedServer = base
      setState({ report: undefined, error: undefined, exportError: undefined, expanded: undefined, page: 0 })
    }
    if (valid()) {
      void load(path, base)
      return
    }
    // 无效日期也代表用户已离开旧查询，不能让旧请求继续更新当前筛选结果。
    request++
    abort?.abort()
    setState("busy", false)
  })
  onMount(() => {
    const poll = setInterval(() => {
      if (visible() && !state.busy) refresh()
    }, 30_000)
    const reveal = () => {
      if (visible() && !state.busy) refresh()
    }
    document.addEventListener("visibilitychange", reveal)
    const slot = root?.closest("[data-settings-panel]")
    const observer = new MutationObserver(reveal)
    if (slot) observer.observe(slot, { attributes: true, attributeFilter: ["hidden"] })
    onCleanup(() => {
      clearInterval(poll)
      observer.disconnect()
      document.removeEventListener("visibilitychange", reveal)
    })
  })
  onCleanup(() => {
    disposed = true
    request++
    abort?.abort()
  })

  const filter = (value: Partial<UsageQuery>) => {
    setState("query", value)
    setState({ page: 0, expanded: undefined, exportError: undefined })
  }
  const period = (range: UsageQuery["range"]) =>
    filter(range === "custom" && state.report ? { range, from: state.report.from, to: state.report.to } : { range })
  const grouping = (value: Grouping) => setState({ group: value, page: 0, expanded: undefined, search: "" })
  const sorting = (value: Sort) =>
    setState({ sort: value, ascending: state.sort === value ? !state.ascending : value === "label", page: 0 })
  const rows = createMemo(() => {
    const source = state.report?.[state.group] ?? []
    const search = state.search.trim().toLowerCase()
    return source
      .filter((row) => !search || `${row.label} ${row.secondary} ${secondary(row)}`.toLowerCase().includes(search))
      .toSorted(
        (a, b) =>
          (state.sort === "label" ? a.label.localeCompare(b.label) : a[state.sort] - b[state.sort]) *
            (state.ascending ? 1 : -1) || a.id.localeCompare(b.id),
      )
  })
  const pages = () => Math.max(1, Math.ceil(rows().length / PAGE_SIZE))
  const page = () => Math.min(state.page, pages() - 1)
  const pageRows = () => rows().slice(page() * PAGE_SIZE, (page() + 1) * PAGE_SIZE)
  const exportCSV = () => {
    if (!state.report || state.busy) return
    setState("exportError", undefined)
    const blob = new Blob(
      [
        usageCSV(
          state.report,
          state.group,
          rows().map((row) => ({ ...row, secondary: secondary(row) })),
        ),
      ],
      { type: "text/csv;charset=utf-8" },
    )
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `onelab-usage-${state.group}-${state.report.from}-${state.report.to}.csv`
    document.body.append(anchor)
    try {
      anchor.click()
    } catch {
      setState("exportError", "Could not download the usage report. Please retry.")
    }
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
  const openSession = (row: UsageGroup) => {
    if (!row.projectID || !row.available) return
    if (props.services?.openSession) {
      props.services.openSession(row.projectID, row.id)
      return
    }
    dialog?.close()
    navigate?.(`/${encodeURIComponent(row.projectID)}/session/${encodeURIComponent(row.id)}`)
  }
  const expand = (row: UsageGroup) => setState("expanded", state.expanded === row.id ? undefined : row.id)
  const number = (value: number) => formatTokens(value, false)
  const percent = (value: number) =>
    new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value)
  const inputTokens = () =>
    state.report
      ? state.report.totals.tokens.input + state.report.totals.tokens.cacheRead + state.report.totals.tokens.cacheWrite
      : 0

  return (
    <PanelScroll>
      <PanelHeader title="Usage Stats" description={label()} />
      <PanelBody>
        <div class="usage-stats" ref={root}>
          <div class="usage-toolbar">
            <div class="usage-segment" role="group" aria-label="Usage period">
              <For each={USAGE_RANGES}>
                {(range) => (
                  <button type="button" aria-pressed={state.query.range === range.id} onClick={() => period(range.id)}>
                    {range.label}
                  </button>
                )}
              </For>
            </div>
            <div class="usage-toolbar__actions">
              <Tooltip value="Refresh usage">
                <IconButton
                  icon="refresh"
                  variant="ghost"
                  aria-label="Refresh usage"
                  disabled={state.busy || !valid()}
                  onClick={refresh}
                />
              </Tooltip>
              <Tooltip value="Export CSV">
                <IconButton
                  icon="download"
                  variant="ghost"
                  aria-label="Export usage CSV"
                  disabled={!state.report?.totals.requests || state.busy || !valid()}
                  onClick={exportCSV}
                />
              </Tooltip>
            </div>
          </div>
          <Show when={state.query.range === "custom"}>
            <div class="usage-dates">
              <label>
                From
                <input
                  type="date"
                  class="settings-field"
                  aria-label="Usage start date"
                  max={localDate(today)}
                  value={state.query.from}
                  onChange={(event) => filter({ from: event.currentTarget.value })}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  class="settings-field"
                  aria-label="Usage end date"
                  max={localDate(today)}
                  value={state.query.to}
                  onChange={(event) => filter({ to: event.currentTarget.value })}
                />
              </label>
            </div>
          </Show>
          <div class="usage-filters">
            <FilterMenu
              ariaLabel="Filter usage by project"
              value={state.query.project}
              onSelect={(project) => filter({ project })}
              options={[{ id: "", label: "All projects" }, ...(state.report?.options.projects ?? [])]}
            />
            <FilterMenu
              ariaLabel="Filter usage by provider"
              value={state.query.provider}
              onSelect={(provider) => filter({ provider, model: "" })}
              options={[
                { id: "", label: "All providers" },
                ...(state.report?.options.providers ?? []).map((id) => ({ id, label: providerLabel(id) })),
              ]}
            />
            <FilterMenu
              ariaLabel="Filter usage by model"
              value={state.query.model}
              onSelect={(model) => filter({ model })}
              options={[
                { id: "", label: "All models" },
                ...(state.report?.options.models ?? [])
                  .filter((model) => !state.query.provider || model.providerID === state.query.provider)
                  .map((model) => ({ id: model.id, label: `${model.label} / ${providerLabel(model.providerID)}` })),
              ]}
            />
            <Show when={hasFilters()}>
              <Tooltip value="Clear filters">
                <IconButton
                  icon="close"
                  variant="ghost"
                  aria-label="Clear usage filters"
                  onClick={() => filter({ project: "", provider: "", model: "" })}
                />
              </Tooltip>
            </Show>
          </div>
          <Show when={!valid()}>
            <p class="usage-notice" role="alert">
              Choose a valid date range of up to ten years.
            </p>
          </Show>
          <Show when={state.error || state.exportError}>
            <div class="usage-notice" role="alert">
              <Icon name="alert-circle" size="small" />
              <span>
                {state.error ?? state.exportError}
                {state.error && state.report ? " Showing the last loaded report." : ""}
              </span>
            </div>
          </Show>
          <Show
            when={state.report}
            fallback={
              <Show
                when={state.busy}
                fallback={
                  <div class="usage-empty">
                    <Icon name="activity" size="large" />
                    <strong>Usage unavailable</strong>
                    <button type="button" class="settings-button" data-variant="ghost" onClick={refresh}>
                      Retry
                    </button>
                  </div>
                }
              >
                <div class="usage-loading" role="status" aria-label="Loading usage statistics">
                  <div class="usage-loading__metrics">
                    <For each={[1, 2, 3, 4]}>{() => <span />}</For>
                  </div>
                  <span class="usage-loading__chart" />
                </div>
              </Show>
            }
          >
            {(report) => (
              <div class="usage-content" aria-busy={state.busy}>
                <div class="usage-meta">
                  <span>
                    {usageDate(report().from, true)} - {usageDate(report().to, true)}
                  </span>
                  <span>{report().timeZone}</span>
                </div>
                <div class="usage-metrics" aria-label="Usage summary">
                  <div class="usage-metric">
                    <span class="usage-metric__label">Total tokens</span>
                    <strong class="usage-metric__value" title={number(report().totals.total)}>
                      <AnimatedUsage value={report().totals.total} />
                    </strong>
                    <span class="usage-metric__detail">
                      {usageChange(report().totals.total, report().previous?.total)
                        ? `${usageChange(report().totals.total, report().previous?.total)} vs previous period`
                        : `${report().activeDays} active day${report().activeDays === 1 ? "" : "s"}`}
                    </span>
                  </div>
                  <div class="usage-metric">
                    <span class="usage-metric__label">Input tokens</span>
                    <strong class="usage-metric__value" title={number(inputTokens())}>
                      <AnimatedUsage value={inputTokens()} />
                    </strong>
                    <span class="usage-metric__detail">{percent(report().cacheHitRate)} cache hit rate</span>
                  </div>
                  <div class="usage-metric">
                    <span class="usage-metric__label">Output tokens</span>
                    <strong class="usage-metric__value" title={number(report().totals.tokens.output)}>
                      <AnimatedUsage value={report().totals.tokens.output} />
                    </strong>
                    <span class="usage-metric__detail">
                      {formatTokens(report().totals.tokens.reasoning)} reasoning tokens included
                    </span>
                  </div>
                  <div class="usage-metric">
                    <span class="usage-metric__label">Model requests</span>
                    <strong class="usage-metric__value">
                      <AnimatedUsage value={report().totals.requests} />
                    </strong>
                    <span class="usage-metric__detail">{number(report().totals.sessions)} sessions</span>
                  </div>
                </div>
                <Show
                  when={report().totals.requests > 0}
                  fallback={
                    <div class="usage-empty">
                      <Icon name="activity" size="large" />
                      <strong>No usage in this period</strong>
                      <p>
                        {hasFilters()
                          ? "No recorded requests match the selected filters."
                          : "No completed model requests have been recorded for these dates."}
                      </p>
                    </div>
                  }
                >
                  <section class="usage-section" aria-label="Token breakdown">
                    <div class="usage-composition" aria-hidden="true">
                      <For each={USAGE_SERIES}>
                        {(series) => (
                          <span
                            data-usage-color={series.color}
                            style={{
                              width: `${report().totals.total ? (report().totals.tokens[series.key] / report().totals.total) * 100 : 0}%`,
                            }}
                          />
                        )}
                      </For>
                    </div>
                    <UsageBreakdown tokens={report().totals.tokens} />
                    <span class="usage-caption">
                      Reasoning: {formatTokens(report().totals.tokens.reasoning)} (included in output)
                    </span>
                  </section>
                  <UsageTrend report={report()} />
                  <UsageActivity
                    report={report()}
                    onDay={(date) => filter({ range: "custom", from: date, to: date })}
                  />
                  <section class="usage-section" aria-label="Usage breakdown">
                    <div class="usage-section-head">
                      <h3>Breakdown</h3>
                      <div class="usage-segment" role="tablist" aria-label="Usage breakdown">
                        <For each={["models", "projects", "sessions"] as const}>
                          {(kind) => (
                            <button
                              type="button"
                              role="tab"
                              aria-selected={state.group === kind}
                              onClick={() => grouping(kind)}
                            >
                              {kind[0].toUpperCase() + kind.slice(1)}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                    <SearchInput
                      value={state.search}
                      onInput={(search) => setState({ search, page: 0, expanded: undefined })}
                      placeholder={`Search ${state.group}`}
                      ariaLabel={`Search usage ${state.group}`}
                    />
                    <div class="usage-table-scroll" role="tabpanel" aria-label={`${state.group} usage`}>
                      <table class="usage-table">
                        <thead>
                          <tr>
                            <th
                              scope="col"
                              aria-sort={
                                state.sort === "label" ? (state.ascending ? "ascending" : "descending") : "none"
                              }
                            >
                              <button type="button" class="usage-sort" onClick={() => sorting("label")}>
                                Source
                              </button>
                            </th>
                            <For
                              each={
                                [
                                  { key: "total", label: "Tokens" },
                                  { key: "requests", label: "Requests" },
                                ] as const
                              }
                            >
                              {(column) => (
                                <th
                                  scope="col"
                                  classList={{ "usage-requests": column.key === "requests" }}
                                  aria-sort={
                                    state.sort === column.key ? (state.ascending ? "ascending" : "descending") : "none"
                                  }
                                >
                                  <button type="button" class="usage-sort" onClick={() => sorting(column.key)}>
                                    {column.label}
                                    <Show when={state.sort === column.key}>
                                      <Icon name={state.ascending ? "arrow-up" : "chevron-down"} size="small" />
                                    </Show>
                                  </button>
                                </th>
                              )}
                            </For>
                            <th scope="col">
                              <span class="sr-only">Details</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={pageRows()}>
                            {(row) => (
                              <>
                                <tr>
                                  <td>
                                    <button
                                      type="button"
                                      class="usage-source"
                                      aria-expanded={state.expanded === row.id}
                                      onClick={() => expand(row)}
                                    >
                                      {row.label}
                                    </button>
                                    <span class="usage-source__secondary">
                                      {secondary(row)}
                                      {state.group === "sessions" && !row.available ? " / Deleted session" : ""}
                                    </span>
                                    <div
                                      class="usage-share"
                                      aria-label={`${new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(report().totals.total ? row.total / report().totals.total : 0)} of tokens`}
                                    >
                                      <span class="usage-share__track" aria-hidden="true">
                                        <i
                                          style={{
                                            width: `${report().totals.total ? (row.total / report().totals.total) * 100 : 0}%`,
                                          }}
                                        />
                                      </span>
                                      <span>
                                        {new Intl.NumberFormat(undefined, {
                                          style: "percent",
                                          maximumFractionDigits: 1,
                                        }).format(report().totals.total ? row.total / report().totals.total : 0)}
                                      </span>
                                    </div>
                                  </td>
                                  <td title={number(row.total)}>{formatTokens(row.total)}</td>
                                  <td class="usage-requests">{number(row.requests)}</td>
                                  <td>
                                    <IconButton
                                      icon="chevron-down"
                                      style={{ transform: state.expanded === row.id ? "rotate(180deg)" : "none" }}
                                      variant="ghost"
                                      aria-label={`Details for ${row.label}`}
                                      aria-expanded={state.expanded === row.id}
                                      onClick={() => expand(row)}
                                    />
                                  </td>
                                </tr>
                                <Show when={state.expanded === row.id}>
                                  <tr class="usage-table__detail">
                                    <td colSpan={4}>
                                      <UsageBreakdown tokens={row.tokens} reasoning />
                                      <div class="usage-detail-actions">
                                        <span class="usage-caption">
                                          {number(row.requests)} requests / {number(row.sessions)} sessions / Last used{" "}
                                          {new Intl.DateTimeFormat(undefined, {
                                            timeZone: zone,
                                            dateStyle: "medium",
                                          }).format(row.lastUsed)}
                                        </span>
                                        <Show
                                          when={state.group === "sessions"}
                                          fallback={
                                            <button
                                              type="button"
                                              class="settings-button"
                                              data-variant="ghost"
                                              onClick={() =>
                                                filter(
                                                  state.group === "models"
                                                    ? { model: row.id, provider: row.providerID ?? "" }
                                                    : { project: row.id },
                                                )
                                              }
                                            >
                                              Filter {state.group === "models" ? "model" : "project"}
                                            </button>
                                          }
                                        >
                                          <Show when={row.available}>
                                            <Tooltip value="Open session">
                                              <IconButton
                                                icon="arrow-right"
                                                variant="ghost"
                                                aria-label={`Open session ${row.label}`}
                                                onClick={() => openSession(row)}
                                              />
                                            </Tooltip>
                                          </Show>
                                        </Show>
                                      </div>
                                    </td>
                                  </tr>
                                </Show>
                              </>
                            )}
                          </For>
                        </tbody>
                      </table>
                      <Show when={!rows().length}>
                        <div class="usage-empty">
                          <strong>No matching {state.group}</strong>
                        </div>
                      </Show>
                    </div>
                    <div class="usage-pagination">
                      <span>
                        {rows().length
                          ? `${page() * PAGE_SIZE + 1}-${Math.min((page() + 1) * PAGE_SIZE, rows().length)} of ${rows().length}`
                          : "0 results"}
                      </span>
                      <Tooltip value="Previous page">
                        <IconButton
                          icon="chevron-left"
                          variant="ghost"
                          aria-label="Previous usage page"
                          disabled={page() === 0}
                          onClick={() => setState("page", page() - 1)}
                        />
                      </Tooltip>
                      <Tooltip value="Next page">
                        <IconButton
                          icon="chevron-right"
                          variant="ghost"
                          aria-label="Next usage page"
                          disabled={page() + 1 >= pages()}
                          onClick={() => setState("page", page() + 1)}
                        />
                      </Tooltip>
                    </div>
                  </section>
                </Show>
                <Show when={report().quality.skipped > 0}>
                  <p class="usage-notice" role="status">
                    {report().quality.skipped} unreadable records excluded. Totals may be incomplete.
                  </p>
                </Show>
                <details class="usage-accounting">
                  <summary>Accounting details</summary>
                  <dl class="usage-breakdown">
                    <div>
                      <dt>Historical usage</dt>
                      <dd>{number(report().quality.historical)} requests</dd>
                    </div>
                    <div>
                      <dt>Unreported usage</dt>
                      <dd>{number(Math.max(0, report().totals.unreported - report().quality.historical))} requests</dd>
                    </div>
                    <div>
                      <dt>Background model calls</dt>
                      <dd>{number(report().totals.background)} requests</dd>
                    </div>
                  </dl>
                  <p class="usage-caption">
                    Input includes cache reads and writes. Total = input + output; reasoning is included in output.
                    Historical usage covers retained conversations. New records survive session deletion. Calls without
                    a provider usage response have no recoverable token count.
                  </p>
                </details>
                <div class="usage-footer">
                  <span class="usage-caption" title={sdk.url}>
                    {label()}
                  </span>
                  <span class="usage-caption" role="status">
                    {state.busy
                      ? "Refreshing"
                      : `Updated ${new Intl.DateTimeFormat(undefined, { timeZone: zone, timeStyle: "short" }).format(report().generatedAt)}`}
                  </span>
                </div>
              </div>
            )}
          </Show>
        </div>
      </PanelBody>
    </PanelScroll>
  )
}

export default UsageStats
