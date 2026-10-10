import { For, Show, createEffect, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { Switch } from "@synsci/ui/switch"
import { Icon } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useWorkspaces } from "@/workspaces/context"
import {
  AddMenu,
  Card,
  EmptyState,
  FilterMenu,
  FormButton,
  PanelBody,
  PanelHeader,
  PanelScroll,
  SearchInput,
  Section,
  Toolbar,
} from "./_shared"
import { settingsApi } from "./api"
import { SpecialistAvatar, SpecialistEditor } from "./SpecialistEditor"
import { createSpecialistsState, type SpecialistProfile, type SpecialistServices } from "./specialists-state"
import "./specialists.css"

function useSpecialistServices(): SpecialistServices {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const location = useLocation()
  const navigate = useNavigate()
  const dialog = useDialog()
  const workspaces = useWorkspaces()
  const remote = workspaces.active()
  const projectID =
    location.pathname.match(/^\/(prj_[^/]+)\/session/)?.[1] ?? remote?.projectID ?? workspaces.state.tasksProjectID
  const base = sdk.url
  const request = <T,>(path: string, init?: RequestInit) =>
    settingsApi<T>(base, platform.fetch ?? fetch, path, {
      ...init,
      headers: { ...(projectID ? { "x-openscience-project": projectID } : {}), ...init?.headers },
    })
  return {
    request,
    label: remote?.name ?? "Local",
    subscribe: (refresh) =>
      sdk.event.on("global", (event) => {
        if (event.type === "specialist.updated") refresh()
      }),
    async chat() {
      const session = await request<{ id: string; projectID: string }>(projectID ? "/session" : "/workspace/task", {
        method: "POST",
        body: JSON.stringify({ title: "Create a specialist" }),
      })
      dialog.close()
      navigate(`/${session.projectID}/session/${session.id}?customize=1`)
    },
  }
}

export function Specialists(props: { services?: SpecialistServices } = {}) {
  const services = props.services ?? useSpecialistServices()
  const model = createSpecialistsState(services)
  const state = model.state
  const [ui, setUI] = createStore<{
    confirmation?: { kind: "discard" | "reload" | "remove"; profile?: SpecialistProfile }
  }>({})
  let root: HTMLDivElement | undefined
  let previousFocus: HTMLElement | undefined
  createEffect(
    on(
      () => state.mutationError,
      (message) => {
        if (message) queueMicrotask(() => root?.querySelector<HTMLElement>("[data-specialist-error]")?.focus())
      },
    ),
  )
  createEffect(
    on(
      () => ui.confirmation,
      (confirmation) => {
        if (confirmation) {
          previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
          queueMicrotask(() => root?.querySelector<HTMLButtonElement>(".specialist-confirmation button")?.focus())
        } else if (previousFocus?.isConnected) previousFocus.focus()
      },
    ),
  )
  const back = () => (model.dirty() ? setUI("confirmation", { kind: "discard" }) : model.close())
  const confirm = async () => {
    const action = ui.confirmation
    if (!action) return
    setUI("confirmation", undefined)
    if (action.kind === "discard") model.close()
    if (action.kind === "reload") await model.reloadDraft()
    if (action.kind === "remove" && action.profile) await model.remove(action.profile)
  }
  onMount(() => {
    void model.load()
    const refresh = () => {
      if (!document.hidden && !root?.closest("[data-settings-panel][hidden]") && !state.loading && !state.writing)
        void model.load()
    }
    const observer = new MutationObserver(refresh)
    const slot = root?.closest("[data-settings-panel]")
    if (slot) observer.observe(slot, { attributes: true, attributeFilter: ["hidden"] })
    window.addEventListener("focus", refresh)
    const unsubscribe = services.subscribe?.(refresh)
    onCleanup(() => {
      unsubscribe?.()
      observer.disconnect()
      window.removeEventListener("focus", refresh)
    })
  })
  return (
    <PanelScroll>
      <PanelHeader
        title={
          state.editor
            ? state.editor?.name
              ? `Specialists · ${state.editor?.draft.displayName}`
              : "Specialists · New specialist"
            : "Specialists"
        }
        description={`Build a team of experts for your research. Profiles are shared by projects on ${services.label}.`}
        toolbar={
          <Show when={state.editor}>
            <FormButton
              label="Back to specialists"
              variant="ghost"
              disabled={state.writing || !!ui.confirmation}
              onClick={back}
            />
          </Show>
        }
      />
      <PanelBody>
        <div ref={root} class="specialists-panel">
          <Show when={ui.confirmation}>
            <div class="specialist-confirmation" role="alertdialog" aria-label="Confirm specialist change">
              <p>
                {ui.confirmation?.kind === "discard"
                  ? "Discard unsaved changes?"
                  : ui.confirmation?.kind === "reload"
                    ? "Replace your draft with the latest saved profile? Unsaved edits will be discarded."
                    : ui.confirmation?.profile?.source === "builtin"
                      ? `Restore ${ui.confirmation?.profile?.displayName} to its built-in defaults?`
                      : `Delete ${ui.confirmation?.profile?.displayName}? It will no longer be available for delegation.`}
              </p>
              <div class="specialist-actions">
                <FormButton label="Keep editing" variant="ghost" onClick={() => setUI("confirmation", undefined)} />
                <FormButton label="Confirm" variant="danger" onClick={() => void confirm()} />
              </div>
            </div>
          </Show>
          <Show when={state.error}>
            <div role="alert" class="settings-alert">
              <span>{state.error}</span>
              <FormButton
                label="Retry"
                variant="ghost"
                disabled={state.loading || state.writing}
                onClick={() => void model.load()}
              />
            </div>
          </Show>
          <Show when={state.mutationError}>
            <div role="alert" tabIndex={-1} data-specialist-error class="settings-alert">
              <span>{state.mutationError}</span>
              <Show when={state.conflict}>
                <FormButton
                  label={state.editor ? "Reload saved profile" : "Refresh specialists"}
                  variant="ghost"
                  onClick={() => (state.editor ? setUI("confirmation", { kind: "reload" }) : void model.load())}
                />
              </Show>
            </div>
          </Show>
          <Show when={state.notice}>
            <p role="status" class="specialist-caption">
              {state.notice}
            </p>
          </Show>
          <div inert={!!ui.confirmation}>
            <Show
              when={state.editor}
              keyed
              fallback={
                <>
                  <Toolbar>
                    <FilterMenu
                      value={state.filter}
                      onSelect={(value) => model.setState("filter", value)}
                      ariaLabel="Filter specialists"
                      options={[
                        { id: "all", label: "All", count: state.data?.profiles.length ?? 0 },
                        { id: "builtin", label: "Built-in" },
                        { id: "custom", label: "Custom" },
                        { id: "configured", label: "Configured" },
                        { id: "enabled", label: "Enabled" },
                        { id: "disabled", label: "Disabled" },
                      ]}
                    />
                    <SearchInput
                      value={state.query}
                      onInput={(value) => model.setState("query", value)}
                      placeholder="Search specialists…"
                      ariaLabel="Search specialists"
                    />
                    <Show
                      when={!state.writing}
                      fallback={
                        <span role="status" class="specialist-caption">
                          Saving…
                        </span>
                      }
                    >
                      <AddMenu
                        disabled={!state.data}
                        label="Add specialist"
                        items={[
                          {
                            icon: "bubble-5",
                            label: "Chat with OneLab",
                            description: "Describe an expert and build it together",
                            onSelect: () => void model.chat(),
                          },
                          {
                            icon: "edit",
                            label: "Write from scratch",
                            description: "Define identity, instructions and capabilities",
                            onSelect: () => model.edit(),
                          },
                        ]}
                      />
                    </Show>
                  </Toolbar>
                  <Show when={state.loading && !state.data}>
                    <p role="status" class="specialist-caption">
                      Loading specialists…
                    </p>
                  </Show>
                  <For
                    each={[
                      { source: "custom", title: "Your specialists" },
                      { source: "builtin", title: "Built-in" },
                      { source: "configured", title: "From configuration" },
                    ]}
                  >
                    {(group) => (
                      <Show when={model.filtered().some((x) => x.source === group.source)}>
                        <Section title={group.title}>
                          <Card>
                            <For each={model.filtered().filter((x) => x.source === group.source)}>
                              {(profile) => (
                                <div class="specialist-row" data-disabled={profile.enabled === false}>
                                  <button
                                    type="button"
                                    class="specialist-open"
                                    aria-label={`Edit ${profile.displayName}`}
                                    disabled={state.writing}
                                    onClick={() => model.edit(profile)}
                                  >
                                    <SpecialistAvatar icon={profile.icon} color={profile.color} />
                                    <span class="specialist-row-copy">
                                      <strong>{profile.displayName}</strong>
                                      <span>
                                        {profile.description || `Delegate research tasks to ${profile.name}.`}
                                      </span>
                                      <small>
                                        {profile.name} · {profile.enabled === false ? "Disabled" : "Enabled"}
                                        {profile.updatedAt ? " · Customized" : ""}
                                      </small>
                                    </span>
                                  </button>
                                  <div class="specialist-row-controls">
                                    <button
                                      type="button"
                                      class="specialist-icon-button"
                                      aria-label={`Duplicate ${profile.displayName}`}
                                      title="Duplicate specialist"
                                      disabled={state.writing}
                                      onClick={() => model.edit(profile, true)}
                                    >
                                      <Icon name="copy" size="small" />
                                    </button>
                                    <Show when={profile.source !== "configured"}>
                                      <button
                                        type="button"
                                        class="specialist-icon-button"
                                        aria-label={`${profile.source === "builtin" ? "Reset" : "Delete"} ${profile.displayName}`}
                                        title={profile.source === "builtin" ? "Restore defaults" : "Delete specialist"}
                                        disabled={state.writing}
                                        onClick={() => setUI("confirmation", { kind: "remove", profile })}
                                      >
                                        <Icon name={profile.source === "builtin" ? "refresh" : "trash"} size="small" />
                                      </button>
                                      <Switch
                                        hideLabel
                                        checked={profile.enabled !== false}
                                        disabled={state.writing}
                                        onChange={() => void model.toggle(profile)}
                                      >
                                        Enable {profile.displayName}
                                      </Switch>
                                    </Show>
                                  </div>
                                </div>
                              )}
                            </For>
                          </Card>
                        </Section>
                      </Show>
                    )}
                  </For>
                  <Show when={state.data && !model.filtered().length}>
                    <Card>
                      <EmptyState
                        title="No matching specialists."
                        hint="Try another search or create an expert for your research."
                      />
                    </Card>
                  </Show>
                </>
              }
            >
              {(editor) => <SpecialistEditor model={model} editor={editor} cancel={back} />}
            </Show>
          </div>
        </div>
      </PanelBody>
    </PanelScroll>
  )
}
export default Specialists
