import { createResource, createSignal, Show } from "solid-js"
import { SettingsPanelStack } from "./panel-stack"
import { progressive, steady } from "./_shared"

export function createPanelStackFixture(onReady: (select: (id: "models" | "network") => void) => void) {
  const [active, setActive] = createSignal<"models" | "network">("models")
  const mounts = { models: 0, network: 0 }
  const Models = () => {
    mounts.models += 1
    return <input aria-label="Model filter" value="remember me" />
  }
  const Network = () => {
    mounts.network += 1
    return <div>Network settings</div>
  }
  onReady(setActive)

  return {
    mounts,
    view: () => (
      <SettingsPanelStack
        active={active}
        panels={() => [
          { id: "models", component: Models },
          { id: "network", component: Network },
        ]}
      />
    ),
  }
}

/** A panel whose list comes from a resource the test can resolve by hand. */
export function createRefreshingPanelFixture(input: { steady: boolean; progressive?: boolean }) {
  let resolve!: (items: string[]) => void
  let reject!: (error: Error) => void
  const next = () =>
    new Promise<string[]>((done, fail) => {
      resolve = done
      reject = fail
    })
  const loader = () => next()
  let refetch!: () => void
  const Panel = () => {
    const [items, actions] = input.progressive
      ? progressive(createResource(loader))
      : input.steady
        ? steady(createResource(loader))
        : createResource(loader)
    refetch = () => void actions.refetch()
    return (
      <ul aria-label="Runtimes">
        <Show when={items.error}>
          <li role="alert">Failed to load runtimes</li>
        </Show>
        <Show when={items.loading}>
          <li role="status">Loading runtimes</li>
        </Show>
        {(items() ?? []).map((item) => (
          <li>{item}</li>
        ))}
      </ul>
    )
  }
  return {
    resolve: (items: string[]) => resolve(items),
    reject: (error: Error) => reject(error),
    refetch: () => refetch(),
    view: () => <SettingsPanelStack active={() => "local"} panels={() => [{ id: "local", component: Panel }]} />,
  }
}
