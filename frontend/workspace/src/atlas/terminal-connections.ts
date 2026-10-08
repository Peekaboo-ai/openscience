import { createStore } from "solid-js/store"

export function createTerminalConnections(active: () => string | undefined) {
  const [states, setStates] = createStore<Record<string, { error: string } | undefined>>({})
  const current = () => {
    const id = active()
    return id ? states[id] : undefined
  }
  return {
    pending: () => !!active() && !current(),
    error: () => current()?.error ?? "",
    connected: (id: string) => setStates(id, { error: "" }),
    failed: (id: string, error: Error) => setStates(id, { error: error.message }),
    retain(ids: string[]) {
      const retained = new Set(ids)
      for (const id of Object.keys(states)) if (!retained.has(id)) setStates(id, undefined)
    },
  }
}
