import { batch, createMemo, createResource, For, Show } from "solid-js"
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
import { FilterMenu, steady } from "./_shared"

const protocols = [
  { id: "openai-chat-completions", label: "OpenAI Chat Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
] as const
type Protocol = (typeof protocols)[number]["id"]
type Connection = {
  id: string
  name: string
  baseURL: string
  protocol: Protocol
  thinking: "auto" | "adaptive"
  models: string[]
  hasKey: boolean
  context: number
  output: number
  limits: Record<string, ModelLimit>
}
type ModelLimit = {
  context: number
  output: number
  input?: number
  mode: "auto" | "manual"
  source: "catalog" | "endpoint" | "fallback" | "manual"
}
const empty = () => ({
  open: false,
  id: "",
  name: "",
  url: "",
  protocol: "openai-chat-completions" as Protocol,
  thinking: "auto" as "auto" | "adaptive",
  key: "",
  hasKey: false,
  savedURL: "",
  query: "",
  manual: "",
  models: [] as string[],
  selected: [] as string[],
  limits: {} as Record<string, ModelLimit>,
  detected: {} as Record<string, ModelLimit>,
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
  const [connections, { refetch, mutate }] = steady(
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
              protocol: connection.protocol ?? "openai-chat-completions",
              thinking: connection.thinking ?? "auto",
              savedURL: connection.baseURL,
              hasKey: connection.hasKey,
              models: connection.models,
              selected: connection.models,
              limits: connection.limits,
              detected: Object.fromEntries(
                Object.entries(connection.limits).filter(([, limit]) => limit.mode === "auto"),
              ),
            }
          : {}),
      }),
    )
  const toggle = (id: string, checked: boolean) =>
    setState(
      "selected",
      checked ? [...new Set([...state.selected, id])] : state.selected.filter((value) => value !== id),
    )
  const endpoint = () => ({
    id: state.id || undefined,
    url: state.url.trim(),
    key: state.key.trim() || undefined,
    protocol: state.protocol,
  })
  const discover = async () => {
    setState({ busy: "discover", error: "" })
    try {
      const result = await call<{ baseURL: string; models: string[]; limits: Record<string, ModelLimit> }>("/models", {
        method: "POST",
        body: JSON.stringify(endpoint()),
      })
      // 保留用户明确选择的 ID；模型发现结果不应悄悄删掉手动配置。
      batch(() => {
        setState({
          models: [...new Set([...result.models, ...state.selected])].sort(),
          discovered: true,
          detected: result.limits,
        })
        for (const [id, limit] of Object.entries(result.limits)) {
          if (state.limits[id]?.mode !== "manual") setState("limits", id, limit)
        }
      })
    } catch (error) {
      setState("error", message(error))
    } finally {
      setState("busy", "")
    }
  }
  const refresh = () => {
    void sync
      .refreshProviders()
      .catch((error) => setState("error", `Changes saved. The model picker could not refresh: ${message(error)}`))
  }
  const save = async () => {
    if (state.busy) return
    setState({ busy: "save", error: "" })
    try {
      const result = await call<Connection>("", {
        method: "POST",
        body: JSON.stringify({
          ...endpoint(),
          name: state.name.trim(),
          thinking: state.thinking,
          models: state.selected,
          limits: Object.fromEntries(state.selected.map((id) => [id, state.limits[id]])),
        }),
      })
      batch(() => {
        for (const modelID of result.models) models.setVisibility({ providerID: result.id, modelID }, true)
        mutate((items = []) => [...items.filter((item) => item.id !== result.id), result])
        // 保存后保持表单、滚动与焦点，目录刷新在后台进行；密钥只清空显示值。
        setState({
          id: result.id,
          savedURL: result.baseURL,
          url: result.baseURL,
          key: "",
          hasKey: true,
          limits: result.limits,
        })
      })
      showToast({ title: "Custom connection saved" })
      refresh()
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
      mutate((items = []) => items.filter((item) => item.id !== connection.id))
      refresh()
      showToast({ title: "Custom connection removed" })
    } catch (error) {
      setState("error", message(error))
    } finally {
      setState("busy", "")
    }
  }
  const invalidate = () => {
    setState({ models: [...state.selected], discovered: false, error: "" })
    // 更换地址后不沿用旧网关的能力；目录默认值和用户覆盖仍可使用，换密钥不影响能力。
    setState(
      "limits",
      reconcile(
        Object.fromEntries(
          Object.entries(state.limits).filter(([, limit]) => limit.mode === "manual" || limit.source !== "endpoint"),
        ),
      ),
    )
    setState(
      "detected",
      reconcile(Object.fromEntries(Object.entries(state.detected).filter(([, limit]) => limit.source !== "endpoint"))),
    )
  }
  const resolveLimits = async (ids: string[]) => {
    const result = await call<{ limits: Record<string, ModelLimit> }>("/limits", {
      method: "POST",
      body: JSON.stringify({ models: ids }),
    })
    for (const [id, limit] of Object.entries(result.limits)) {
      setState("detected", id, limit)
      if (state.limits[id]?.mode !== "manual") setState("limits", id, limit)
    }
    return result.limits
  }
  const addModel = async () => {
    if (state.busy || !state.manual.trim()) return
    const id = state.manual.trim()
    setState({ busy: "limits", error: "" })
    try {
      await resolveLimits([id])
      setState({
        models: [...new Set([...state.models, id])].sort(),
        selected: [...new Set([...state.selected, id])],
        manual: "",
        query: "",
      })
    } catch (error) {
      setState("error", message(error))
    } finally {
      setState("busy", "")
    }
  }
  const automatic = async (id: string) => {
    setState({ busy: "limits", error: "" })
    try {
      const limit = state.detected[id] ?? (await resolveLimits([id]))[id]
      setState("limits", id, { ...limit, mode: "auto" })
    } catch (error) {
      setState("error", message(error))
    } finally {
      setState("busy", "")
    }
  }

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
              Connect models using your provider’s API URL, key, and protocol.
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
          aria-busy={!!state.busy}
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div class="models-custom-fields">
            <div class="models-key-field models-custom-wide">
              <span class="text-12-medium text-text-weak">API protocol</span>
              <FilterMenu
                options={[...protocols]}
                value={state.protocol}
                ariaLabel="API protocol"
                disabled={!!state.busy}
                onSelect={(id) => {
                  const item = protocols.find((item) => item.id === id)
                  if (!item) return
                  setState({ protocol: item.id, thinking: "auto" })
                  invalidate()
                }}
              />
              <span class="text-12-regular text-text-weak">
                Match the protocol supported by your provider. The model name does not determine the API format.
              </span>
            </div>
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
                  setState({ discovered: false, error: "" })
                }}
              />
            </label>
          </div>
          <p class="text-12-regular text-text-weak">
            Keys are stored in the owner-only auth file on the selected backend. Model discovery requests /models; you
            can also add model IDs manually.
          </p>
          <Show when={state.protocol === "anthropic-messages"}>
            <div class="models-key-field">
              <span class="text-12-medium text-text-weak">Thinking mode</span>
              <FilterMenu
                options={[
                  { id: "auto", label: "Model default" },
                  { id: "adaptive", label: "Adaptive thinking" },
                ]}
                value={state.thinking}
                ariaLabel="Thinking mode"
                disabled={!!state.busy}
                onSelect={(value) => setState("thinking", value === "adaptive" ? "adaptive" : "auto")}
              />
              <span class="text-12-regular text-text-weak">
                Enable adaptive thinking only when your endpoint supports it. Choose reasoning effort in the
                conversation.
              </span>
            </div>
          </Show>
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
              onClick={() => void addModel()}
            >
              Add model
            </Button>
          </div>
          <details class="models-custom-limits">
            <summary class="text-12-medium text-text-weak">Model limits</summary>
            <p class="text-12-regular text-text-weak">
              Limits are detected per model. Override them if your API provider uses different limits. Automatic history
              compaction uses these values.
            </p>
            <For each={state.selected}>
              {(id) => (
                <fieldset class="models-custom-limit-row">
                  <legend class="text-12-medium text-text-strong">{id}</legend>
                  <Show
                    when={state.limits[id]}
                    fallback={
                      <div class="models-custom-toolbar">
                        <span class="text-12-regular text-text-weak">
                          API URL changed. Saving will use model catalog defaults.
                        </span>
                        <Button
                          type="button"
                          size="small"
                          variant="secondary"
                          disabled={!!state.busy}
                          onClick={() => void automatic(id)}
                        >
                          Use detected limits
                        </Button>
                      </div>
                    }
                  >
                    {(limit) => (
                      <>
                        <div class="models-custom-toolbar">
                          <span class="text-12-regular text-text-weak">
                            {limit().source === "endpoint"
                              ? "Reported by this API"
                              : limit().source === "catalog"
                                ? "Model catalog defaults"
                                : limit().source === "manual"
                                  ? "Custom limits"
                                  : "Unknown model · unverified fallback; check your provider"}
                          </span>
                          <Button
                            type="button"
                            size="small"
                            variant="secondary"
                            disabled={!!state.busy}
                            onClick={() => void automatic(id)}
                          >
                            Use detected limits
                          </Button>
                        </div>
                        <div class="models-custom-fields">
                          <label class="models-key-field">
                            <span class="text-12-medium text-text-weak">Context tokens</span>
                            <input
                              class="settings-field models-key-input"
                              type="number"
                              required
                              min={1024}
                              max={2147483647}
                              step={1}
                              value={limit().context}
                              disabled={!!state.busy}
                              aria-label={`${id} context tokens`}
                              onInput={(event) => {
                                const context = event.currentTarget.valueAsNumber
                                setState("limits", id, {
                                  context,
                                  mode: "manual",
                                  source: "manual",
                                  input: limit().input ? Math.min(limit().input!, context) : undefined,
                                })
                              }}
                            />
                          </label>
                          <label class="models-key-field">
                            <span class="text-12-medium text-text-weak">Maximum output tokens</span>
                            <input
                              class="settings-field models-key-input"
                              type="number"
                              required
                              min={1}
                              max={limit().context}
                              step={1}
                              value={limit().output}
                              disabled={!!state.busy}
                              aria-label={`${id} maximum output tokens`}
                              onInput={(event) =>
                                setState("limits", id, {
                                  output: event.currentTarget.valueAsNumber,
                                  mode: "manual",
                                  source: "manual",
                                })
                              }
                            />
                          </label>
                        </div>
                        <Show when={limit().input}>
                          <p class="text-12-regular text-text-weak">
                            Maximum input tokens: {limit().input?.toLocaleString()}
                          </p>
                        </Show>
                      </>
                    )}
                  </Show>
                </fieldset>
              )}
            </For>
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
                    {" · "}
                    {protocols.find((item) => item.id === connection.protocol)?.label ?? "OpenAI Chat Completions"}
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
