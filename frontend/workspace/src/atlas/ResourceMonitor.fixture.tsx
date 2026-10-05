import { createStore } from "solid-js/store"
import { ResourceMonitor, type MonitorRequest } from "./ResourceMonitor"
import { ComputeTab } from "./ComputeSurface"

export function MonitorFixture(props: {
  request: MonitorRequest
  control: (change: (id: string) => void) => void
  visibility?: (change: (active: boolean) => void) => void
}) {
  const [state, setState] = createStore({ sessionID: "ses_first", active: true })
  props.control((id) => setState("sessionID", id))
  props.visibility?.((active) => setState("active", active))
  return <ResourceMonitor request={props.request} sessionID={state.sessionID} active={state.active} />
}

export function MonitorTabFixture(props: {
  request: MonitorRequest
  control: (change: (state: { open?: boolean; visible?: boolean }) => void) => void
}) {
  const [state, setState] = createStore({ open: false, visible: false })
  props.control(setState)
  const monitor = () => <ResourceMonitor request={props.request} sessionID="ses_first" />
  return (
    <ComputeTab
      open={state.open}
      visible={state.visible}
      monitor={monitor}
      strip={() => undefined}
      kernels={() => undefined}
    />
  )
}
