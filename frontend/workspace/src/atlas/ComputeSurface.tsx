import { Show, type Component, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { HostStrip } from "@/atlas/HostStrip"
import { KernelPanel } from "@/atlas/KernelPanel"
import { ResourceMonitor } from "@/atlas/ResourceMonitor"
import "@/atlas/ComputeSurface.css"

type ComputeSurfaceProps = {
  active?: boolean
  strip?: Component
  kernels?: Component
  monitor?: Component<{ active?: boolean }>
}

export function ComputeTab(props: ComputeSurfaceProps & { open: boolean; visible: boolean }): JSX.Element {
  return (
    <Show when={props.open}>
      <div
        data-component="compute-context"
        aria-hidden={props.visible ? undefined : "true"}
        hidden={!props.visible}
        style={{
          flex: 1,
          "min-height": 0,
          "min-width": 0,
          display: props.visible ? "flex" : "none",
          "flex-direction": "column",
        }}
      >
        <ComputeSurface strip={props.strip} kernels={props.kernels} monitor={props.monitor} />
      </div>
    </Show>
  )
}

/**
 * Project-scoped Compute inventory.
 *
 * This surface is a read-only instrument panel. Agent execution creates
 * kernels, shell commands, or governed remote jobs; Compute only tracks what
 * is live or still needs operational attention. It intentionally owns no
 * configuration, lifecycle controls, or completed-history workflow.
 */
export function ComputeSurface(props: ComputeSurfaceProps = {}): JSX.Element {
  const strip = props.strip ?? HostStrip
  const kernels = props.kernels ?? KernelPanel
  const monitor = props.monitor ?? ResourceMonitor

  return (
    <section class="activity-surface compute-surface" aria-label="Compute">
      <Dynamic component={strip} />
      <div class="compute-surface__body atlas-scroll">
        <Dynamic component={monitor} active={props.active} />
        <div class="compute-surface__panel" data-compute-child="kernels">
          <Dynamic component={kernels} />
        </div>
      </div>
    </section>
  )
}
