import { createMemo, createResource, createSignal, Index, Show, onCleanup, type JSX } from "solid-js"
import type { WorkspaceEnvironmentResponse } from "@synsci/sdk/v2/client"
import { Button } from "@synsci/ui/button"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { hostReading, type Capacity } from "@/atlas/host-instruments"
import { identify } from "@/atlas/poll-identity"
import { createKernelRouteRequester, kernelAPI } from "@/atlas/kernel-api"
import { IconCpu } from "@/atlas/shared/Icon"
import "@/atlas/HostStrip.css"

type HostStripProps = {
  request?: (path: string) => Promise<Response>
}

export function HostStrip(props: HostStripProps = {}): JSX.Element {
  const sdk = props.request ? undefined : useSDK()
  const request = props.request ?? sdk!.request
  const kernelRequest = createKernelRouteRequester(request)
  const client = identify()
  const [health, setHealth] = createSignal<"loading" | "available" | "unavailable">("loading")
  const load = () =>
    kernelRequest(kernelAPI.compute(client))
      .then((response) => (response.ok ? (response.json() as Promise<Capacity>) : undefined))
      .then((capacity) => {
        setHealth(capacity ? "available" : "unavailable")
        return capacity
      })
      .catch(() => {
        setHealth("unavailable")
        return undefined
      })
  const [data, api] = createResource(load)
  const [environmentState, setEnvironmentState] = createStore({ error: "", open: false })
  const [environment, environmentAPI] = createResource(
    () => environmentState.open,
    async () => {
      setEnvironmentState("error", "")
      try {
        const response = await request("/workspace/environment")
        if (!response.ok) throw new Error("Could not read this host's resources. Check the connection and retry.")
        const value = (await response.json()) as WorkspaceEnvironmentResponse
        if (!Array.isArray(value.schedulers) || !Array.isArray(value.accelerators))
          throw new Error("Environment discovery requires the updated backend.")
        return value
      } catch (error) {
        setEnvironmentState("error", error instanceof Error ? error.message : String(error))
        return undefined
      }
    },
  )
  const inventory = createMemo(() =>
    environment.state === "unresolved" || environment.state === "pending" ? undefined : environment.latest,
  )
  const environmentTimer = setInterval(() => {
    if (environmentState.open && !document.hidden && !environment.loading) void environmentAPI.refetch()
  }, 30_000)
  const checks = createMemo(() =>
    [...(inventory()?.schedulers ?? []), ...(inventory()?.accelerators ?? [])].filter(
      (check) => check.status !== "not_installed",
    ),
  )
  const reading = createMemo(() => hostReading(data.latest))
  const memoryTotal = createMemo(() =>
    reading().memory === "memory unavailable"
      ? reading().memory
      : reading()
          .memory.replace(/^of /, "/ ")
          .replace(/ memory$/, ""),
  )
  const refresh = () => {
    if (document.hidden || data.loading) return
    void api.refetch()
  }
  const timer = setInterval(refresh, 2_500)
  document.addEventListener("visibilitychange", refresh)
  onCleanup(() => {
    clearInterval(timer)
    clearInterval(environmentTimer)
    document.removeEventListener("visibilitychange", refresh)
  })

  return (
    <section class="host-strip" aria-label="Current compute host" data-testid="host-strip" data-health={health()}>
      <div class="host-strip__identity">
        <span class="host-strip__glyph" aria-hidden="true">
          <IconCpu size={16} strokeWidth={1.5} />
        </span>
        <div class="host-strip__copy">
          <strong>
            {inventory()?.hostname ?? (sdk?.url.includes("/remote-workspaces/") ? "Remote host" : "This computer")}
          </strong>
          <span>
            {health() === "loading"
              ? "Reading compute…"
              : health() === "unavailable"
                ? "Usage unavailable"
                : `${reading().live} tracked · ${reading().running} running`}
          </span>
        </div>
      </div>

      <div class="host-strip__resources" aria-label="Tracked runtime resources on the connected host">
        <div class="host-strip__metric" data-host-tile="memory">
          <span class="host-strip__label">Runtime memory</span>
          <p>
            <strong class="host-strip__headline">{reading().headline}</strong>
            <span class="host-strip__total">{memoryTotal()}</span>
          </p>
          <Meter value={reading().memoryFill} />
        </div>
        <div class="host-strip__metric" data-host-tile="cpu">
          <span class="host-strip__label">Runtime CPU</span>
          <p>
            <strong class="host-strip__cores-value">{reading().cores}</strong>
            <span class="host-strip__total">cores</span>
          </p>
          <Meter value={reading().cpuFill} />
        </div>
      </div>
      <span class="host-strip__health" aria-live="polite" aria-label={health()} />
      <details
        class="host-strip__environment"
        onToggle={(event) => setEnvironmentState("open", event.currentTarget.open)}
      >
        <summary>Environment & cluster status</summary>
        <div class="host-strip__environment-body">
          <div class="host-strip__environment-heading">
            <span>
              {environment.loading
                ? "Reading environment…"
                : inventory()
                  ? `${inventory()!.authority === "remote" ? "Remote" : "Local"} · ${inventory()!.platform} · ${inventory()!.arch} · ${inventory()!.kind}`
                  : "Environment unavailable"}
            </span>
            <Button
              size="small"
              variant="ghost"
              disabled={environment.loading}
              onClick={() => void environmentAPI.refetch()}
            >
              Refresh
            </Button>
          </div>
          <Show when={environmentState.error}>
            <p role="alert">{environmentState.error}</p>
          </Show>
          <Show when={inventory()}>
            {(info) => (
              <>
                <p>
                  {info().cpu.available} available CPU cores ·{" "}
                  {(Math.min(info().memory.total, info().memory.limit ?? Infinity) / 1024 ** 3).toFixed(1)} GiB memory
                  capacity
                </p>
                <p>
                  These resources belong to the connected node. Cluster capacity and your job allocation may differ.
                </p>
                <Show when={!info().schedulers.some((check) => check.status !== "not_installed")}>
                  <p>No supported scheduler client detected. This host can still run ordinary local workloads.</p>
                </Show>
                <Show when={!info().accelerators.some((check) => check.status !== "not_installed")}>
                  <p>No supported accelerator monitoring client detected. Device availability is unknown.</p>
                </Show>
                <Index each={checks()}>
                  {(check) => (
                    <details class="host-strip__check">
                      <summary>
                        {check().command} <span>{check().status.replaceAll("_", " ")}</span>
                      </summary>
                      <Show when={check().detail}>
                        <p>{check().detail}</p>
                      </Show>
                      <Show when={check().output}>
                        <p>{check().columns}</p>
                        <pre>{check().output}</pre>
                      </Show>
                      <Show when={check().status === "ready" && !check().output}>
                        <p>The query succeeded with no entries.</p>
                      </Show>
                      <Show when={check().truncated}>
                        <p>Output truncated; refine your query in the conversation.</p>
                      </Show>
                    </details>
                  )}
                </Index>
                <Show when={info().runtimes.length}>
                  <p>
                    Detected runtimes:{" "}
                    {info()
                      .runtimes.map((item) => item.name)
                      .join(", ")}
                  </p>
                </Show>
                <small>Updated {new Date(info().sampledAt).toLocaleTimeString()}</small>
              </>
            )}
          </Show>
        </div>
      </details>
    </section>
  )
}

function Meter(props: { value: number }): JSX.Element {
  return (
    <span class="host-strip__meter" role="presentation" aria-hidden="true">
      <i style={{ width: `${Math.round(props.value * 100)}%` }} />
    </span>
  )
}
