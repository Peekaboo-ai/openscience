import { Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { DropdownMenu } from "@synsci/ui/dropdown-menu"
import {
  IconAlertCircle,
  IconChevronDown,
  IconChevronRight,
  IconCloud,
  IconMoreH,
  IconRefresh,
} from "@/atlas/shared/Icon"
import type { RemoteWorkspace } from "./context"

export function RemoteProject(
  props: ParentProps<{
    remote: RemoteWorkspace
    active: boolean
    expanded: boolean
    onToggle: () => void
    onOpen: () => void
    onConnect: () => void
    onDisconnect: () => void
    onRemove: () => void
    onNewConversation: () => void
  }>,
) {
  const [state, setState] = createStore({ details: false })
  const connecting = () => props.remote.state === "connecting"
  const connected = () => props.remote.state === "connected"
  const failed = () => props.remote.state === "error"
  const status = () =>
    connecting() ? "Connecting…" : failed() ? "Connection failed" : connected() ? "Connected" : "Disconnected"
  const detail = () => props.remote.error || props.remote.progress
  const retry = () => `${failed() ? "Retry connection to" : "Connect to"} ${props.remote.name}`
  return (
    <div class="workspace-project workspace-remote-project" data-state={props.remote.state}>
      <div class="workspace-project-row" data-active={props.active}>
        <button
          class="workspace-icon-button"
          aria-label={`Toggle ${props.remote.name}`}
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          {props.expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </button>
        <button
          class="workspace-row-main"
          onClick={props.onOpen}
          title={`${props.remote.name} · ${props.remote.target.kind.toUpperCase()} · ${detail()}`}
        >
          <IconCloud />
          <span>
            {props.remote.name}
            <small role="status" aria-label={`${props.remote.name}: ${status()}`}>
              {props.remote.target.kind.toUpperCase()} · {status()}
            </small>
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenu.Trigger class="workspace-icon-button" aria-label={`Remote actions for ${props.remote.name}`}>
            <IconMoreH size={14} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <Show when={!connecting()}>
                <DropdownMenu.Item onSelect={connected() ? props.onOpen : props.onConnect}>
                  {connected()
                    ? props.remote.projectID
                      ? "Open"
                      : "Choose directory"
                    : failed()
                      ? "Retry connection"
                      : "Connect"}
                </DropdownMenu.Item>
              </Show>
              <Show when={connected() && props.remote.projectID}>
                <DropdownMenu.Item onSelect={props.onNewConversation}>New conversation</DropdownMenu.Item>
              </Show>
              <Show when={connected() || connecting()}>
                <DropdownMenu.Item onSelect={props.onDisconnect}>
                  {connecting() ? "Cancel connection" : "Disconnect"}
                </DropdownMenu.Item>
              </Show>
              <DropdownMenu.Item onSelect={props.onRemove}>Remove bookmark</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
        <Show when={failed()}>
          <button
            class="workspace-icon-button workspace-connection-error"
            aria-label={`Connection details for ${props.remote.name}`}
            aria-expanded={state.details || props.expanded}
            aria-controls={`remote-status-${props.remote.id}`}
            title={detail()}
            onClick={() => {
              const visible = state.details || props.expanded
              setState("details", !visible)
              if (props.expanded) props.onToggle()
            }}
          >
            <IconAlertCircle size={14} />
          </button>
        </Show>
        <Show when={!connected()}>
          <button
            class="workspace-icon-button workspace-reconnect"
            aria-label={connecting() ? `Connecting to ${props.remote.name}` : retry()}
            aria-busy={connecting()}
            disabled={connecting()}
            title={connecting() ? `${detail()} You can continue working.` : retry()}
            onClick={props.onConnect}
          >
            <IconRefresh size={14} />
          </button>
        </Show>
      </div>
      <Show when={!connected() && (props.expanded || (failed() && state.details))}>
        <p id={`remote-status-${props.remote.id}`} class="workspace-hint workspace-connection-detail" role="status">
          {detail()}
          <Show when={connecting()}>
            <span>You can continue working while this connects.</span>
          </Show>
        </p>
      </Show>
      {props.children}
    </div>
  )
}
