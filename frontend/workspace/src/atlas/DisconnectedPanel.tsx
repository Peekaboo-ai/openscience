import { Show, createEffect, on, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@synsci/ui/button"
import { useDialog } from "@synsci/ui/context/dialog"
import { useServer } from "@/context/server"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { FONT_CODE, FONT_SANS } from "@/styles/tokens"
import { useWorkspaces } from "@/workspaces/context"

// 远端连接状态来自本地连接管理器；探测超时不能误称为本机进程退出。
export function DisconnectedPanel(): JSX.Element {
  const server = useServer()
  const dialog = useDialog()
  const workspaces = useWorkspaces()
  const [state, setState] = createStore({ retrying: false, error: "" })
  const remote = () => {
    const current = workspaces.active()
    return current && workspaces.remoteBase(current.id) === server.url ? current : undefined
  }
  const disconnected = () => remote()?.state === "error" || remote()?.state === "disconnected"
  const connecting = () => remote()?.state === "connecting"
  const retry = async () => {
    if (state.retrying) return
    setState({ retrying: true, error: "" })
    try {
      const current = remote()
      if (current && disconnected()) await workspaces.connect(current.id)
      else await server.refresh()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : "Could not reconnect. Try again.")
    } finally {
      setState("retrying", false)
    }
  }
  createEffect(
    on(
      () => server.url,
      () => setState("error", ""),
    ),
  )
  createEffect(
    on(
      () => remote()?.state,
      (next, previous) => {
        if (next === "connected" && previous && previous !== "connected") void server.refresh()
      },
    ),
  )

  return (
    <Show when={server.healthy() === false || disconnected() || connecting()}>
      <div
        role={connecting() ? "status" : "alert"}
        aria-label={connecting() ? "Connecting to workspace" : "Server connection lost"}
        style={{
          display: "flex",
          "align-items": "center",
          gap: "12px",
          padding: "9px 18px",
          background: connecting() ? "var(--color-bg-subtle)" : "var(--color-error-muted, rgba(239,68,68,0.15))",
          "border-bottom": connecting() ? "1px solid var(--color-border)" : "1px solid var(--color-error, #ef4444)",
          "flex-shrink": 0,
          "flex-wrap": "wrap",
        }}
      >
        <span
          style={{
            width: "7px",
            height: "7px",
            "border-radius": "50%",
            background: connecting() ? "var(--color-text-muted)" : "var(--color-error, #ef4444)",
            "flex-shrink": 0,
          }}
        />
        <div style={{ flex: "1 1 320px", "min-width": 0 }}>
          <div
            style={{
              "font-family": FONT_SANS,
              "font-size": "12.5px",
              "font-weight": "var(--font-weight-medium)",
              color: "var(--color-text)",
            }}
          >
            {connecting()
              ? `Connecting to ${remote()!.name}…`
              : remote()
                ? `Can't reach remote workspace “${remote()!.name}”`
                : server.isLocal()
                  ? "Can't reach your local OpenScience server"
                  : "Can't reach your OpenScience server"}
          </div>
          <div
            style={{
              "font-family": FONT_SANS,
              "font-size": "11.5px",
              color: "var(--color-text-muted)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            {server.name} ·{" "}
            <Show
              when={remote()}
              fallback={
                <Show when={server.isLocal()} fallback="Check the server URL or switch servers">
                  Start it with <code style={{ "font-family": FONT_CODE }}>openscience serve</code>
                </Show>
              }
            >
              {connecting() ? remote()!.progress : remote()!.error || "Check the remote connection, then retry."}
            </Show>
            <Show when={server.failures() > 1}> · {server.failures()} failed checks</Show>
            <Show when={state.error}> · {state.error}</Show>
          </div>
        </div>
        <Button
          type="button"
          size="large"
          variant="primary"
          disabled={state.retrying || connecting() || (!disconnected() && server.checking())}
          onClick={() => void retry()}
          style={{
            "flex-shrink": 0,
          }}
        >
          {state.retrying || connecting()
            ? "Connecting…"
            : disconnected()
              ? "Reconnect"
              : server.checking()
                ? "Checking…"
                : "Retry Now"}
        </Button>
        <Button
          type="button"
          size="large"
          variant="secondary"
          onClick={() => dialog.show(() => <DialogSelectServer />)}
          style={{
            "flex-shrink": 0,
          }}
        >
          Switch Server
        </Button>
      </div>
    </Show>
  )
}
