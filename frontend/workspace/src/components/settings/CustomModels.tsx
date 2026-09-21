import { createMemo, createResource, For, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Button } from "@synsci/ui/button"
import { Checkbox } from "@synsci/ui/checkbox"
import { Icon } from "@synsci/ui/icon"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { useModels } from "@/context/models"
import { confirmDialog } from "@/atlas/dialogs"
import { useDialog } from "@synsci/ui/context/dialog"
import { settingsApi } from "./api"
import { steady } from "./_shared"

type Connection = {
  id: string
  name: string
  baseURL: string
  models: string[]
  hasKey: boolean
  context: number
  output: number
}
const empty = () => ({
  open: false,
  id: "",
  name: "",
  url: "",
  key: "",
  hasKey: false,
  savedURL: "",
  query: "",
  manual: "",
  models: [] as string[],
  selected: [] as string[],
  context: 32768,
  output: 8192,
  busy: "",
  error: "",
  discovered: false,
})
const message = (error: unknown) => (error instanceof Error ? error.message : "The request failed. Please try again.")

export function CustomModels() {
  const sdk = useGlobalSDK()
  const dialog = useDialog()
  const sync = useGlobalSync()
  const platform = usePlatform()
  const models = useModels()
  const call = <T,>(path = "", init?: RequestInit) =>
    settingsApi<T>(sdk.url, platform.fetch ?? fetch, `/settings/model-connections${path}`, init)
  const [connections, { refetch }] = steady(
    createResource(() => call<{ connections: Connection[] }>().then((data) => data.connections)),
  )
  const [state, setState] = createStore(empty())
  const filtered = createMemo(() =>
    state.models.filter((id) => id.toLowerCase().includes(state.query.trim().toLowerCase())),
  )
  const ready = () => !!state.url.trim() && (!!state.key.trim() || (state.hasKey && state.url === state.savedURL))
  const edit = (connection?: Connection) =>
    setState(
      reconcile({
        ...empty(),
        open: true,
        ...(connection
          ? {
              id: connection.id,
              name: connection.name,
              url: connection.baseURL,
              savedURL: connection.baseURL,
              hasKey: connection.hasKey,
              models: connection.models,
              selected: connection.models,
              context: connection.context,
              output: connection.output,
            }
          : {}),
      }),
    )
  const toggle = (id: string, checked: boolean) =>
    setState(
      "selected",
      checked ? [...new Set([...state.selected, id])] : state.selected.filter((value) => value !== id),
    )
  const endpoint = () => ({ id: state.id || undefined, url: state.url.trim(), key: state.key.trim() || undefined })
  const discover = async () => {
    setState({ busy: "discover", error: "" })
    try {
      const result = await call<{ baseURL: string; models: string[] }>("/models", {
        method: "POST",
        body: JSON.stringify(endpoint()),
      })
      // 保留用户明确选择的 ID；模型发现结果不应悄悄删掉手动配置。
      setState({ models: [...new Set([...result.models, ...state.selected])].sort(), discovered: true })
    } catch (error) {
      setState("error", message(error))
    } finally {
      setState("busy", "")
    }
  }
  const save = async () => {
    setState({ busy: "save", error: "" })
    try {
      const result = await call<{ id: string; models: string[] }>("", {
        method: "POST",
        body: JSON.stringify({
          ...endpoint(),
          name: state.name.trim(),
          models: state.selected,
          context: state.context,
          output: state.output,
        }),
      })
      for (const modelID of result.models) models.setVisibility({ providerID: result.id, modelID }, true)
      setState(reconcile({ ...empty(), busy: "save" }))
      showToast({ title: "Custom connection saved" })
      await Promise.all([refetch(), sync.refreshProviders()])
    } catch (error) {
      setState("error", message(error))
    } finally {
      setState("busy", "")
    }
  }
  const remove = async (connection: Connection) => {
    const confirmed = await confirmDialog(dialog, {
      title: `Remove ${connection.name}?`,
      message: "This removes this connection, its saved API key, and its models from the model picker.",
      confirmLabel: "Remove connection",
      danger: true,
    })
    if (!confirmed) return
    setState({ busy: "remove", error: "" })
    try {
      await call(`/${connection.id}`, { method: "DELETE" })
      if (state.id === connection.id) setState(reconcile({ ...empty(), busy: "remove" }))
      await Promise.all([refetch(), sync.refreshProviders()])
      showToast({ title: "Custom connection removed" })
    } catch (error) {
      setState("error", message(error))
    } finally {
      setState("busy", "")
    }
  }
  const invalidate = () => setState({ models: [...state.selected], discovered: false, error: "" })

  return (
    <div class="models-provider-keys">
      <div class="settings-row models-compact-row models-provider-key-heading">
        <div class="models-provider-identity">
          <span class="settings-row-logo" aria-hidden="true">
            <Icon name="providers" size="small" />
          </span>
          <div class="models-provider-copy">
            <span class="text-14-medium text-text-strong">Custom API connections</span>
            <span class="text-12-regular text-text-weak">
              Connect models with an OpenAI-compatible API URL and key.
            </span>
          </div>
        </div>
        <span class="models-row-action">
          <Button
            class="settings-panel-action models-secondary-action"
            size="small"
            variant="secondary"
            disabled={!!state.busy}
            aria-expanded={state.open}
            aria-controls="models-custom-form"
            onClick={() => (state.open ? setState(reconcile(empty())) : edit())}
          >
            {state.open ? "Cancel" : "Add connection"}
          </Button>
        </span>
      </div>
      <Show when={state.error || connections.error}>
        <div class="models-custom-notice text-12-regular" role="alert">
          {state.error || message(connections.error)}{" "}
          <Show when={connections.error}>
            <Button size="small" variant="secondary" onClick={() => void refetch()}>
              Retry
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={state.open}>
        <form
          id="models-custom-form"
          class="models-custom-form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div class="models-custom-fields">
            <label class="models-key-field">
              <span class="text-12-medium text-text-weak">Connection name</span>
              <input
                class="settings-field models-key-input"
                required
                maxlength={80}
                value={state.name}
                disabled={!!state.busy}
                placeholder="My model provider"
                onInput={(event) => setState("name", event.currentTarget.value)}
              />
            </label>
            <label class="models-key-field">
              <span class="text-12-medium text-text-weak">API base URL</span>
              <input
                class="settings-field models-key-input"
                type="url"
                required
                value={state.url}
                disabled={!!state.busy}
                placeholder="https://api.example.com/v1"
                onInput={(event) => {
                  setState("url", event.currentTarget.value)
                  invalidate()
                }}
              />
            </label>
            <label class="models-key-field models-custom-wide">
              <span class="text-12-medium text-text-weak">API key</span>
              <input
                class="settings-field models-key-input"
                type="password"
                autocomplete="off"
                spellcheck={false}
                value={state.key}
                disabled={!!state.busy}
                placeholder={state.hasKey ? "Leave blank to keep the saved key" : "Enter API key"}
                onInput={(event) => {
                  setState("key", event.currentTarget.value)
                  invalidate()
                }}
              />
            </label>
          </div>
          <p class="text-12-regular text-text-weak">
            Keys are stored in the owner-only local auth file. Use the base URL for Chat Completions; model discovery
            requests /models.
          </p>
          <div class="models-custom-toolbar">
            <Button
              type="button"
              size="small"
              variant="secondary"
              class="settings-panel-action models-secondary-action"
              disabled={!!state.busy || !ready()}
              onClick={() => void discover()}
            >
              {state.busy === "discover" ? "Fetching models…" : "Fetch models"}
            </Button>
            <span class="text-12-regular text-text-weak" role="status" aria-live="polite">
              {state.selected.length} selected{state.discovered ? ` · ${state.models.length} models` : ""}
            </span>
          </div>
          <Show when={state.models.length}>
            <input
              aria-label="Search custom models"
              class="settings-field models-key-input"
              type="search"
              placeholder="Search models…"
              value={state.query}
              onInput={(event) => setState("query", event.currentTarget.value)}
            />
            <div class="models-custom-toolbar">
              <Button
                type="button"
                size="small"
                variant="secondary"
                class="models-secondary-action"
                disabled={!!state.busy}
                onClick={() => setState("selected", [...new Set([...state.selected, ...filtered()])])}
              >
                Select filtered
              </Button>
              <Button
                type="button"
                size="small"
                variant="secondary"
                class="models-secondary-action"
                disabled={!!state.busy || !state.selected.length}
                onClick={() => setState("selected", [])}
              >
                Clear selection
              </Button>
            </div>
            <div
              class="models-custom-list"
              role="group"
              aria-label="Available custom models"
              aria-busy={state.busy === "discover"}
            >
              <For each={filtered()}>
                {(id) => (
                  <div class="models-custom-option">
                    <Checkbox
                      checked={state.selected.includes(id)}
                      disabled={!!state.busy}
                      onChange={(checked) => toggle(id, checked)}
                    >
                      {id}
                    </Checkbox>
                  </div>
                )}
              </For>
              <Show when={!filtered().length}>
                <p class="text-12-regular text-text-weak">No models match your search.</p>
              </Show>
            </div>
          </Show>
          <Show when={state.discovered && !state.models.length}>
            <p class="text-12-regular text-text-weak" role="status">
              This endpoint returned no models. You can enter a model ID below.
            </p>
          </Show>
          <div class="models-custom-manual">
            <label class="models-key-field">
              <span class="text-12-medium text-text-weak">Add a model ID manually</span>
              <input
                class="settings-field models-key-input"
                placeholder="Model ID (if discovery is unavailable)"
                maxlength={256}
                value={state.manual}
                disabled={!!state.busy}
                onInput={(event) => setState("manual", event.currentTarget.value)}
              />
            </label>
            <Button
              type="button"
              size="small"
              variant="secondary"
              class="models-secondary-action"
              disabled={!!state.busy || !state.manual.trim()}
              onClick={() => {
                const id = state.manual.trim()
                setState({
                  models: [...new Set([...state.models, id])].sort(),
                  selected: [...new Set([...state.selected, id])],
                  manual: "",
                  query: "",
                })
              }}
            >
              Add model
            </Button>
          </div>
          <details class="models-custom-limits">
            <summary class="text-12-medium text-text-weak">Model limits</summary>
            <div class="models-custom-fields">
              <label class="models-key-field">
                <span class="text-12-medium text-text-weak">Context tokens</span>
                <input
                  class="settings-field models-key-input"
                  type="number"
                  required
                  min={1024}
                  max={2097152}
                  step={1}
                  value={state.context}
                  disabled={!!state.busy}
                  onInput={(event) => setState("context", event.currentTarget.valueAsNumber)}
                />
              </label>
              <label class="models-key-field">
                <span class="text-12-medium text-text-weak">Maximum output tokens</span>
                <input
                  class="settings-field models-key-input"
                  type="number"
                  required
                  min={1}
                  max={Math.min(state.context, 262144)}
                  step={1}
                  value={state.output}
                  disabled={!!state.busy}
                  onInput={(event) => setState("output", event.currentTarget.valueAsNumber)}
                />
              </label>
            </div>
            <p class="text-12-regular text-text-weak">
              Applied to the selected text models. Set limits supported by your provider. Discovery does not verify tool
              support or pricing.
            </p>
          </details>
          <div class="models-custom-toolbar">
            <Button
              type="submit"
              size="small"
              variant="primary"
              class="settings-panel-action models-primary-action"
              disabled={!!state.busy || !ready() || !state.name.trim() || !state.selected.length}
            >
              {state.busy === "save" ? "Saving…" : state.id ? "Save changes" : "Save connection"}
            </Button>
          </div>
        </form>
      </Show>
      <div class="models-connected-providers">
        <For each={connections()}>
          {(connection) => (
            <div class="settings-row models-compact-row models-provider-row">
              <div class="models-provider-identity">
                <span class="settings-row-logo" aria-hidden="true">
                  <Icon name="providers" size="small" />
                </span>
                <div class="models-provider-copy">
                  <span class="text-14-medium text-text-strong">{connection.name}</span>
                  <span class="models-custom-url text-12-regular text-text-weak" title={connection.baseURL}>
                    {connection.baseURL}
                  </span>
                  <span class="text-12-regular text-text-weak">
                    {connection.models.length} models · {connection.hasKey ? "Key saved" : "API key required"}
                  </span>
                </div>
              </div>
              <div class="models-connection-actions">
                <Button
                  size="small"
                  variant="secondary"
                  class="models-secondary-action"
                  disabled={!!state.busy}
                  onClick={() => edit(connection)}
                >
                  Edit
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  class="models-secondary-action"
                  disabled={!!state.busy}
                  onClick={() => void remove(connection)}
                >
                  Remove
                </Button>
              </div>
            </div>
          )}
        </For>
      </div>
      <Show when={!connections.loading && !connections.error && !connections()?.length && !state.open}>
        <p class="models-provider-empty" role="status">
          No custom API connections configured.
        </p>
      </Show>
    </div>
  )
}
