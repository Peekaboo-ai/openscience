import { Match, Switch } from "solid-js"
import { IconMessageSquare } from "@/atlas/shared/Icon"
import type { SessionStatus } from "@synsci/sdk/v2/client"

export function ConversationStatus(props: { status?: SessionStatus["type"]; completed?: number }) {
  const running = () => !!props.status && props.status !== "idle"
  const label = () =>
    props.status === "retry" ? "Retrying" : props.status === "compacting" ? "Compacting context" : "Running"
  return (
    <span class="workspace-conversation-status">
      <Switch fallback={<IconMessageSquare size={14} />}>
        <Match when={running()}>
          <span class="workspace-conversation-running" role="img" aria-label={label()} title={label()} />
        </Match>
        <Match when={props.completed}>
          <span
            class="workspace-conversation-completed"
            role="img"
            aria-label="Completed · Unread"
            title="Completed · Unread"
          />
        </Match>
      </Switch>
    </span>
  )
}
