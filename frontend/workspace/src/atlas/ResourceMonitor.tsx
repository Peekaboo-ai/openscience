import { For, Index, Show, batch, createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { Button } from "@synsci/ui/button"
import { useSDK } from "@/context/sdk"
import type { ProjectRequest } from "@/utils/openscience-fetch"
import { ResourceChart } from "./ResourceChart"
import {
  appendSample,
  memoryLabel,
  memoryPercent,
  parseMonitor,
  percentLabel,
  sampleScope,
  type MonitorReport,
  type MonitorSample,
} from "./compute-monitor"
import "./ResourceMonitor.css"

export type MonitorRequest = (...args: Parameters<ProjectRequest>) => ReturnType<ProjectRequest>
type Props = { request?: MonitorRequest; sessionID?: string; scope?: string; active?: boolean }
export function ResourceMonitor(props: Props = {}) {
  const sdk = props.request ? undefined : useSDK()
  const params = props.request ? undefined : useParams()
  const request = props.request ?? sdk!.request
  const sessionID = () => props.sessionID ?? (params?.id && params.id !== "new" ? params.id : undefined)
  const initial = () => ({
    target: "",
    node: "",
    paused: false,
    minutes: 5,
    loading: true,
    error: "",
    report: undefined as MonitorReport | undefined,
    choice: undefined as MonitorReport["targets"][number] | undefined,
    history: [] as MonitorSample[],
    deviceHistory: [] as MonitorSample[],
  })
  const [state, setState] = createStore(initial())
  const contexts = new Map<string, ReturnType<typeof initial>>()
  const histories = new Map<string, MonitorSample[]>()
  const deviceHistories = new Map<string, MonitorSample[]>()
  const scope = () => JSON.stringify([sdk?.url ?? "", sdk?.scope ?? props.scope ?? "", sessionID() ?? ""])
  let previousScope: string | undefined
  createEffect(() => {
    const next = scope()
    untrack(() => {
      if (previousScope) contexts.set(previousScope, structuredClone(unwrap(state)))
      previousScope = next
      const saved = contexts.get(next)
      contexts.delete(next)
      setState(reconcile(saved ?? initial()))
      while (contexts.size > 8) contexts.delete(contexts.keys().next().value!)
    })
  })
  createEffect(() => {
    const target = state.target
    const node = state.node
    const session = sessionID()
    const owner = scope()
    if (state.paused || props.active === false) return
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    let missed = true
    let missedDevices = true
    let expected = 0
    const interval = () =>
      Math.max(
        1000,
        Math.min(
          60_000,
          untrack(() => state.report?.intervalMs ?? 5000),
        ),
      )
    const poll = async () => {
      if (running || lifetime.signal.aborted) return
      clearTimeout(timer)
      running = true
      const started = Date.now()
      if (expected && started - expected > Math.max(15_000, interval() * 3)) missed = missedDevices = true
      try {
        const query: Record<string, string> = {
          ...(session ? { sessionID: session } : {}),
          ...(target ? { target } : {}),
          ...(node ? { node } : {}),
        }
        const response = await request(
          "/settings/compute/monitor",
          { cache: "no-store", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]) },
          query,
        )
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "Resource monitoring requires an updated backend on this host."
              : "Could not refresh node resources. Reconnecting automatically…",
          )
        const report = parseMonitor(await response.json())
        if (lifetime.signal.aborted) return
        const previousNode = untrack(() => (state.report?.selected === report.selected ? state.report.node : undefined))
        const selectedNode = report.node ?? (node || previousNode) ?? ""
        const currentHistories = untrack(() =>
          state.report?.selected === report.selected &&
          (!selectedNode || !state.report.node || state.report.node === selectedNode)
            ? structuredClone({ host: unwrap(state.history), devices: unwrap(state.deviceHistory) })
            : { host: [], devices: [] },
        )
        const hostname = report.sample?.hostname ?? currentHistories.host.at(-1)?.hostname ?? ""
        const key = JSON.stringify([owner, report.selected, selectedNode, hostname])
        const sameHost = currentHistories.host.at(-1)?.hostname === hostname
        const previous = histories.get(key) ?? (sameHost ? currentHistories.host : [])
        if (previous.length && !sameHost) missed = missedDevices = true
        const readingScope = sampleScope(report.sample ?? currentHistories.devices.at(-1))
        const deviceKey = JSON.stringify([key, readingScope])
        // 同一作业重新分配设备后，旧设备的采样不能拼接到新分配的曲线上。
        const sameAllocation = sampleScope(currentHistories.devices.at(-1)) === readingScope
        const previousDevices = deviceHistories.get(deviceKey) ?? (sameAllocation ? currentHistories.devices : [])
        // 恢复缓存范围时保留离开期间的缺测，CPU 采样成功不代表当时验证过这些设备。
        if (previousDevices.length && !sameAllocation) missedDevices = true
        const history = report.sample ? appendSample(previous, { ...report.sample, gapBefore: missed }) : previous
        const deviceHistory = report.sample
          ? appendSample(previousDevices, { ...report.sample, gapBefore: missedDevices })
          : previousDevices
        if (report.sample && report.sample.sampledAt > (previous.at(-1)?.sampledAt ?? -Infinity)) missed = false
        if (report.sample && report.sample.sampledAt > (previousDevices.at(-1)?.sampledAt ?? -Infinity))
          missedDevices = false
        if (!report.sample) missed = missedDevices = true
        histories.set(key, history)
        deviceHistories.set(deviceKey, deviceHistory)
        while (histories.size > 32) histories.delete(histories.keys().next().value!)
        while (deviceHistories.size > 32) deviceHistories.delete(deviceHistories.keys().next().value!)
        const choice =
          report.targets.find((target) => target.id === report.selected) ??
          untrack(() => (state.choice?.id === report.selected ? structuredClone(unwrap(state.choice)) : undefined))
        // Store 的合并更新会修改旧对象；界面数据与各会话历史分开持有，避免恢复会话时串改曲线。
        batch(() => {
          setState("report", reconcile(structuredClone(report)))
          setState({
            choice,
            history: structuredClone(history),
            deviceHistory: structuredClone(deviceHistory),
            error: "",
            loading: false,
          })
        })
      } catch (error) {
        missed = missedDevices = true
        if (!lifetime.signal.aborted)
          setState({ error: error instanceof Error ? error.message : String(error), loading: false })
      } finally {
        running = false
        if (!lifetime.signal.aborted) {
          const delay = untrack(() => (state.error ? Math.max(10_000, interval()) : interval()))
          // 以采样开始时间排程，避免远端请求耗时不断叠加到采样间隔。
          expected = Math.max(Date.now() + 100, started + delay)
          timer = setTimeout(poll, expected - Date.now())
        }
      }
    }
    void poll()
    const visibility = () => {
      if (!document.hidden) void poll()
    }
    document.addEventListener("visibilitychange", visibility)
    onCleanup(() => {
      lifetime.abort()
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", visibility)
    })
  })
  const latest = () => state.history.at(-1)
  const accelerators = () => state.deviceHistory.at(-1)
  const end = () => latest()?.sampledAt ?? Date.now()
  const current = createMemo(() => {
    const id = state.target || state.report?.selected
    return (
      state.report?.targets.find((target) => target.id === id) ?? (state.choice?.id === id ? state.choice : undefined)
    )
  })
  const nodes = createMemo(() => {
    const available = (state.report?.nodes ?? []).map((node) => ({ id: node, missing: false }))
    return state.node && !available.some((node) => node.id === state.node)
      ? [{ id: state.node, missing: true }, ...available]
      : available
  })
  const status = () =>
    state.paused
      ? "Paused"
      : state.error
        ? latest()
          ? "Stale"
          : "Unavailable"
        : state.loading
          ? "Connecting"
          : state.report?.state === "live"
            ? "Live"
            : state.report?.state === "queued"
              ? "Queued"
              : state.report?.state === "finished"
                ? "Finished"
                : "Unavailable"
  const chooseTarget = (value: string) =>
    setState({
      target: value,
      node: "",
      choice: state.report?.targets.find((target) => target.id === value),
      history: [],
      deviceHistory: [],
      error: "",
      loading: true,
      paused: false,
    })
  const chooseNode = (value: string) =>
    setState({
      target: state.target || state.report?.selected || "",
      node: value,
      history: [],
      deviceHistory: [],
      error: "",
      loading: true,
      paused: false,
    })
  const issues = () => [...(state.report?.issues ?? []), ...(latest()?.issues ?? [])]
  return (
    <section class="resource-monitor" aria-label="Resource monitor" data-state={status().toLowerCase()}>
      <header class="resource-monitor__heading">
        <h3>Resource monitor</h3>
        <span class="resource-monitor__status">
          <i aria-hidden="true" />
          {status()}
        </span>
        <Button
          size="small"
          variant="ghost"
          onClick={() => setState("paused", !state.paused)}
          aria-label={state.paused ? "Resume resource monitoring" : "Pause resource monitoring"}
        >
          {state.paused ? "Resume" : "Pause"}
        </Button>
      </header>
      <div class="resource-monitor__controls">
        <label>
          <span>Compute target</span>
          <select
            aria-label="Compute target"
            value={state.target}
            onChange={(event) => chooseTarget(event.currentTarget.value)}
          >
            <option value="" selected={!state.target}>
              Automatic · active job
            </option>
            <Show when={state.target && !state.report?.targets.some((target) => target.id === state.target)}>
              <option value={state.target} selected disabled>
                {current()?.label ?? state.target} · {state.report?.state === "finished" ? "finished" : "unavailable"}
              </option>
            </Show>
            <Index each={state.report?.targets ?? []}>
              {(target) => (
                <option value={target().id} selected={state.target === target().id}>
                  {target().label}
                  {target().sessionID === sessionID() && target().sessionID ? " · this session" : ""}
                </option>
              )}
            </Index>
          </select>
        </label>
        <Show
          when={
            !state.loading &&
            ((state.report?.nodes.length ?? 0) > 1 || (state.node && !state.report?.nodes.includes(state.node)))
          }
        >
          <label>
            <span>Node</span>
            <select
              aria-label="Compute node"
              value={state.node || state.report?.node}
              onChange={(event) => chooseNode(event.currentTarget.value)}
            >
              <Index each={nodes()}>
                {(node) => (
                  <option
                    value={node().id}
                    selected={(state.node || state.report?.node) === node().id}
                    disabled={node().missing}
                  >
                    {node().id}
                    {node().missing ? " · unavailable" : ""}
                  </option>
                )}
              </Index>
            </select>
          </label>
        </Show>
        <label class="resource-monitor__range">
          <span>History</span>
          <select
            aria-label="Resource history range"
            value={state.minutes}
            onChange={(event) => setState("minutes", Number(event.currentTarget.value))}
          >
            <option value="1">1 min</option>
            <option value="5">5 min</option>
            <option value="15">15 min</option>
          </select>
        </label>
      </div>
      <p class="resource-monitor__context">
        {current()?.label ?? "Discovering compute targets…"}
        <Show when={state.report?.node}>
          <span> · {state.report?.node}</span>
        </Show>
      </p>
      <Show when={state.error}>
        <p class="resource-monitor__notice" role="status">
          {state.error}
          {latest() ? " Showing the last successful sample." : ""}
        </p>
      </Show>
      <Show when={!state.error && !state.loading && state.report?.state !== "live" && latest()}>
        <p class="resource-monitor__notice" role="status">
          {state.report?.state === "finished" ? "This job has finished." : "Live node sampling is unavailable."} Showing
          the last successful sample.
        </p>
      </Show>
      <Show
        when={latest()}
        fallback={
          <p class="resource-monitor__empty" role="status">
            {state.paused
              ? "Monitoring is paused. Resume to read node resources."
              : state.loading
                ? "Reading node resources…"
                : state.report?.state === "queued"
                  ? "Waiting for the scheduler to allocate a compute node."
                  : state.report?.state === "finished"
                    ? "This job is no longer running. Select another target to continue monitoring."
                    : "Node telemetry is currently unavailable."}
          </p>
        }
      >
        {(sample) => (
          <>
            <div class="resource-monitor__host">
              <article class="resource-monitor__card">
                <div class="resource-monitor__metric">
                  <span>CPU utilization</span>
                  <strong>{percentLabel(sample().cpu.utilization)}</strong>
                </div>
                <small>{sample().cpu.cores} logical cores · entire node</small>
                <ResourceChart
                  label="CPU utilization"
                  points={state.history.map((point) => ({
                    time: point.sampledAt,
                    primary: point.cpu.utilization,
                    gapBefore: point.gapBefore,
                  }))}
                  minutes={state.minutes}
                  end={end()}
                />
              </article>
              <article class="resource-monitor__card">
                <div class="resource-monitor__metric">
                  <span>System memory</span>
                  <strong>{percentLabel(memoryPercent(sample().memory))}</strong>
                </div>
                <small>{memoryLabel(sample().memory.used, sample().memory.total)} · entire node</small>
                <ResourceChart
                  label="System memory utilization"
                  points={state.history.map((point) => ({
                    time: point.sampledAt,
                    primary: memoryPercent(point.memory),
                    gapBefore: point.gapBefore,
                  }))}
                  minutes={state.minutes}
                  end={end()}
                />
              </article>
            </div>
            <Show
              when={(accelerators()?.devices.length ?? 0) > 0}
              fallback={
                <p class="resource-monitor__empty">
                  {accelerators()?.acceleratorScope?.kind === "unavailable"
                    ? (accelerators()?.acceleratorScope?.reason ??
                      "The accelerators allocated to this job could not be identified. CPU and system memory monitoring remain available.")
                    : accelerators()?.acceleratorScope?.kind === "allocation"
                      ? accelerators()?.acceleratorScope?.expectedDevices === 0
                        ? "No accelerators are allocated to this job."
                        : "Metrics for this job's allocated accelerators are currently unavailable."
                      : "No accelerator metrics available on this node. CPU and memory monitoring remain available."}
                </p>
              }
            >
              <div class="resource-monitor__legend">
                <span>
                  {accelerators()?.acceleratorScope?.kind === "allocation"
                    ? "Allocated accelerators"
                    : "Visible accelerators"}
                  {" · "}
                  {accelerators()?.devices.length}
                </span>
                <span>
                  <i />
                  Compute
                </span>
                <span>
                  <i class="resource-monitor__memory-key" />
                  Memory
                </span>
              </div>
              <div class="resource-monitor__devices">
                <For each={accelerators()?.devices.map((device) => device.id) ?? []}>
                  {(id) => {
                    const device = () => accelerators()!.devices.find((item) => item.id === id)!
                    return (
                      <article class="resource-monitor__card" aria-label={`${device().kind} ${device().name}`}>
                        <div class="resource-monitor__device">
                          <strong title={device().name}>{device().name}</strong>
                          <span>
                            {device().source === "sysfs" ? device().kind : `${device().kind} ${id.split(":").at(-1)}`}
                          </span>
                        </div>
                        <div class="resource-monitor__device-values">
                          <span>
                            Compute <strong>{percentLabel(device().utilization)}</strong>
                          </span>
                          <span>
                            Memory <strong>{percentLabel(device().memoryPercent)}</strong>
                          </span>
                        </div>
                        <small>
                          {memoryLabel(device().memoryUsed, device().memoryTotal)}
                          {device().temperature !== null ? ` · ${device().temperature!.toFixed(0)} °C` : ""}
                          {device().power !== null ? ` · ${device().power!.toFixed(0)} W` : ""}
                        </small>
                        <ResourceChart
                          label={`${device().name} compute and memory utilization`}
                          minutes={state.minutes}
                          end={end()}
                          secondary
                          points={state.deviceHistory.map((point) => {
                            const match = point.devices.find((item) => item.id === id)
                            return {
                              time: point.sampledAt,
                              primary: match?.utilization ?? null,
                              secondary: match?.memoryPercent ?? null,
                              gapBefore: point.gapBefore,
                            }
                          })}
                        />
                        <span class="resource-monitor__source">{device().source}</span>
                      </article>
                    )
                  }}
                </For>
              </div>
            </Show>
            <footer class="resource-monitor__footer">
              Updated {new Date(sample().sampledAt).toLocaleTimeString()} · samples every{" "}
              {(state.report?.intervalMs ?? 5000) / 1000} s<br />
              {accelerators()?.acceleratorScope?.kind === "allocation"
                ? "CPU and system memory cover the entire node. Accelerator metrics cover this job's allocated devices, including other processes using those devices."
                : accelerators()?.acceleratorScope?.kind === "unavailable"
                  ? "CPU and system memory cover the entire node. Accelerator allocation is unavailable."
                  : "Node-wide usage of visible devices, including other workloads."}{" "}
              — means the metric is unavailable.
            </footer>
          </>
        )}
      </Show>
      <Show when={issues().length > 0}>
        <details class="resource-monitor__issues">
          <summary>Monitoring details ({issues().length})</summary>
          <For each={issues()}>{(issue) => <p>{issue}</p>}</For>
        </details>
      </Show>
    </section>
  )
}
