import { Dynamic } from "solid-js/web"
import { ErrorBoundary, For, Suspense, createEffect, onCleanup, type Accessor, type Component } from "solid-js"
import { AtomLoader } from "@synsci/ui/atom-loader"
import { Button } from "@synsci/ui/button"

export interface SettingsPanelStackItem<Id extends string = string> {
  id: Id
  component: Component
}

/**
 * Retains the shell's small recent-panel cache.
 *
 * The shell adds a panel synchronously while its module preloads, so Suspense
 * is a last-resort guard rather than a blocked navigation state. Recently used
 * panels keep local form and scroll state; older hidden panels are unmounted so
 * their subscriptions and oversized trees cannot accumulate indefinitely.
 */
export function SettingsPanelStack<Id extends string>(props: {
  active: Accessor<Id>
  panels: Accessor<SettingsPanelStackItem<Id>[]>
}) {
  const slots = new Map<Id, HTMLElement>()

  createEffect(() => {
    const active = props.active()

    queueMicrotask(() => {
      if (props.active() !== active) return

      const focused = document.activeElement as HTMLElement | null
      const focusedPanel = focused?.closest<HTMLElement>("[data-settings-panel]")
      if (!focusedPanel || focusedPanel.dataset.settingsPanel === active) return

      slots.get(active)?.focus({ preventScroll: true })
    })
  })

  return (
    <For each={props.panels()}>
      {(panel) => (
        <section
          ref={(element) => {
            slots.set(panel.id, element)
            onCleanup(() => slots.delete(panel.id))
          }}
          class="settings-panel-slot"
          data-settings-panel={panel.id}
          hidden={props.active() !== panel.id}
          aria-hidden={props.active() !== panel.id ? "true" : undefined}
          inert={props.active() !== panel.id}
          tabIndex={-1}
        >
          <ErrorBoundary
            fallback={(error, reset) => (
              <div class="settings-page-body">
                <div role="alert" class="settings-alert" data-tone="critical">
                  <span>
                    These settings could not be loaded. {error instanceof Error ? error.message : String(error)}
                  </span>
                  <Button size="small" variant="secondary" onClick={reset}>
                    Retry
                  </Button>
                </div>
              </div>
            )}
          >
            <Suspense
              fallback={
                <div class="settings-panel-loading" role="status" aria-label="Loading settings">
                  <AtomLoader size={144} caption="Loading settings" />
                </div>
              }
            >
              <Dynamic component={panel.component} />
            </Suspense>
          </ErrorBoundary>
        </section>
      )}
    </For>
  )
}
