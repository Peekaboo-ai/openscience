import { For, Show, createMemo, onMount } from "solid-js"
import { Icon, type IconProps } from "@synsci/ui/icon"
import { FormButton, FormField, SearchInput } from "./_shared"
import { specialistID, type SpecialistDraft, type SpecialistsState } from "./specialists-state"

export const specialistIcons: Record<SpecialistDraft["icon"], IconProps["name"]> = {
  brain: "brain",
  flask: "flask",
  atom: "atom",
  code: "code",
  chart: "activity",
  book: "book-open",
  search: "magnifying-glass",
  sparkles: "sparkles",
}
export const specialistColors: SpecialistDraft["color"][] = ["neutral", "blue", "purple", "green", "orange", "pink"]
export function SpecialistAvatar(props: { icon?: SpecialistDraft["icon"]; color?: SpecialistDraft["color"] }) {
  return (
    <span class="specialist-avatar" data-color={props.color ?? "neutral"}>
      <Icon name={specialistIcons[props.icon ?? "brain"]} size="medium" />
    </span>
  )
}

export function SpecialistEditor(props: {
  model: SpecialistsState
  editor: NonNullable<SpecialistsState["state"]["editor"]>
  cancel: () => void
}) {
  const model = props.model
  const state = model.state
  const draft = () => props.editor.draft
  const readonly = () => props.editor.source === "configured"
  const blocked = () => state.writing || readonly()
  const update = <K extends keyof SpecialistDraft>(key: K, value: SpecialistDraft[K]) =>
    model.setState("editor", "draft", key, value)
  const name = (value: string) => {
    update("displayName", value)
    if (!state.editor?.idEdited) update("name", specialistID(value))
  }
  let form: HTMLFormElement | undefined
  onMount(() => form?.querySelector<HTMLInputElement>('input[aria-label="Specialist name"]')?.focus())
  const capabilities = (kind: "skillNames" | "connectors") =>
    kind === "skillNames"
      ? (state.catalog?.skills ?? []).map((x) => ({ name: x.name, description: x.description, unavailable: false }))
      : (state.catalog?.connectors ?? []).map((x) => ({
          name: x.name,
          description: x.enabled ? "Configured connector" : "Disabled in Connectors",
          unavailable: !x.enabled,
        }))
  const results = createMemo(() =>
    state.picker
      ? capabilities(state.picker)
          .filter((x) => `${x.name} ${x.description}`.toLowerCase().includes(state.pickerQuery.toLowerCase()))
          .slice(0, 100)
      : [],
  )
  const select = (kind: "skillNames" | "connectors", name: string) => {
    const values = draft()[kind] ?? []
    update(kind, values.includes(name) ? values.filter((x) => x !== name) : [...values, name])
  }
  return (
    <form
      ref={form}
      class="specialist-editor"
      onSubmit={(e) => {
        e.preventDefault()
        void model.save()
      }}
    >
      <Show when={readonly()}>
        <p class="settings-alert">
          This specialist is managed by your agent configuration. Duplicate it to create an editable profile.
        </p>
      </Show>
      <section class="specialist-section" aria-labelledby="specialist-identity">
        <div>
          <h3 id="specialist-identity">Identity</h3>
          <p class="specialist-caption">How this specialist appears in the registry and delegation menus.</p>
        </div>
        <div class="specialist-preview">
          <SpecialistAvatar icon={draft().icon} color={draft().color} />
          <div>
            <strong>{draft().displayName.trim() || "Untitled specialist"}</strong>
            <p class="specialist-caption">Preview</p>
          </div>
        </div>
        <div class="specialist-identity-controls">
          <fieldset disabled={blocked()}>
            <legend>Color</legend>
            <div class="specialist-swatches">
              <For each={specialistColors}>
                {(color) => (
                  <button
                    type="button"
                    class="specialist-swatch"
                    data-color={color}
                    aria-label={`${color} color`}
                    aria-pressed={draft().color === color}
                    onClick={() => update("color", color)}
                  >
                    <Show when={draft().color === color}>
                      <Icon name="check" size="small" />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </fieldset>
          <label class="specialist-icon-select">
            Icon
            <select
              aria-label="Specialist icon"
              class="settings-field"
              value={draft().icon}
              disabled={blocked()}
              onChange={(e) => update("icon", e.currentTarget.value as SpecialistDraft["icon"])}
            >
              <For each={Object.keys(specialistIcons) as SpecialistDraft["icon"][]}>
                {(icon) => <option value={icon}>{icon[0].toUpperCase() + icon.slice(1)}</option>}
              </For>
            </select>
          </label>
        </div>
        <label class="specialist-field">
          Name
          <input
            aria-label="Specialist name"
            class="settings-field"
            value={draft().displayName}
            maxlength={100}
            placeholder="e.g. Single-cell reviewer"
            disabled={blocked()}
            onInput={(e) => name(e.currentTarget.value)}
          />
        </label>
        <div class="specialist-field">
          <FormField
            label="Agent ID"
            value={draft().name}
            onInput={(value) => {
              model.setState("editor", "idEdited", true)
              update("name", value)
            }}
            disabled={blocked() || !!state.editor?.name}
            placeholder="single-cell-reviewer"
          />
          <p class="specialist-caption">
            Used in delegation. Auto-derived from name; fixed after creation. Use a lowercase identifier for names in
            any language.
          </p>
        </div>
        <FormField
          label="Description"
          value={draft().description}
          onInput={(value) => update("description", value)}
          multiline
          disabled={blocked()}
          placeholder="What problems should the lead delegate to this specialist?"
        />
      </section>
      <section class="specialist-section" aria-labelledby="specialist-instructions">
        <div>
          <h3 id="specialist-instructions">Instructions</h3>
          <p class="specialist-caption">Appended to OneLab’s specialist base prompt. Optional.</p>
        </div>
        <textarea
          aria-label="Specialist instructions"
          class="settings-field specialist-instructions"
          value={draft().instructions}
          maxlength={32000}
          rows={8}
          disabled={blocked()}
          placeholder="Describe the expert’s methods, evidence standards, expected outputs and boundaries."
          onInput={(e) => update("instructions", e.currentTarget.value)}
        />
        <span class="specialist-caption">{draft().instructions.length.toLocaleString()} / 32,000</span>
      </section>
      <section class="specialist-section" aria-labelledby="specialist-capabilities">
        <div>
          <h3 id="specialist-capabilities">Capabilities</h3>
          <p class="specialist-caption">
            Core workspace tools follow project permissions. Choose the skills and connectors this specialist can
            access.
          </p>
        </div>
        <Show when={state.catalogError}>
          <div role="alert" class="settings-alert">
            <span>{state.catalogError}</span>
            <FormButton label="Retry capabilities" variant="ghost" onClick={() => void model.catalog()} />
          </div>
        </Show>
        <Show when={state.catalogLoading}>
          <p class="specialist-caption" role="status">
            Loading available capabilities…
          </p>
        </Show>
        <For each={["skillNames", "connectors"] as const}>
          {(kind) => (
            <div class="specialist-capability">
              <div class="specialist-capability-heading">
                <strong>
                  {kind === "skillNames" ? "Skills" : "Connectors"}{" "}
                  <span class="specialist-count">{draft()[kind] === null ? "All" : draft()[kind]!.length}</span>
                </strong>
                <select
                  aria-label={`${kind === "skillNames" ? "Skills" : "Connectors"} access`}
                  class="settings-control"
                  value={draft()[kind] === null ? "all" : "selected"}
                  disabled={blocked()}
                  onChange={(e) => {
                    update(kind, e.currentTarget.value === "all" ? null : [])
                    model.setState("picker", undefined)
                  }}
                >
                  <option value="all">All available</option>
                  <option value="selected">Selected only</option>
                </select>
              </div>
              <Show
                when={draft()[kind] !== null}
                fallback={
                  <p class="specialist-caption">
                    Includes newly available {kind === "skillNames" ? "skills" : "connectors"} automatically, subject to
                    permissions.
                  </p>
                }
              >
                <div class="specialist-chips">
                  <For each={draft()[kind] ?? []}>
                    {(value) => (
                      <span class="specialist-chip">
                        <Icon name={kind === "skillNames" ? "book-open" : "mcp"} size="small" />
                        <span>
                          {value}
                          <Show when={state.catalog && !capabilities(kind).some((x) => x.name === value)}>
                            <small> · Unavailable</small>
                          </Show>
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove ${value}`}
                          disabled={blocked()}
                          onClick={() => select(kind, value)}
                        >
                          <Icon name="close" size="small" />
                        </button>
                      </span>
                    )}
                  </For>
                  <Show when={!draft()[kind]?.length}>
                    <p class="specialist-caption">No {kind === "skillNames" ? "skills" : "connectors"} selected.</p>
                  </Show>
                </div>
                <FormButton
                  label={`Add ${kind === "skillNames" ? "skills" : "connectors"}`}
                  variant="ghost"
                  disabled={blocked()}
                  onClick={() => model.setState({ picker: state.picker === kind ? undefined : kind, pickerQuery: "" })}
                />
                <Show when={state.picker === kind}>
                  <div
                    class="specialist-picker"
                    role="group"
                    aria-label={`Choose ${kind === "skillNames" ? "skills" : "connectors"}`}
                  >
                    <div class="specialist-picker-search">
                      <SearchInput
                        value={state.pickerQuery}
                        onInput={(value) => model.setState("pickerQuery", value)}
                        placeholder={`Search ${kind === "skillNames" ? "skills" : "connectors"}…`}
                      />
                      <FormButton label="Done" variant="ghost" onClick={() => model.setState("picker", undefined)} />
                    </div>
                    <div class="specialist-picker-list">
                      <For each={results()}>
                        {(item) => (
                          <label class="specialist-picker-row">
                            <input
                              type="checkbox"
                              checked={draft()[kind]?.includes(item.name) ?? false}
                              disabled={blocked()}
                              onChange={() => select(kind, item.name)}
                            />
                            <span>
                              <strong>{item.name}</strong>
                              <small>{item.description}</small>
                            </span>
                          </label>
                        )}
                      </For>
                      <Show when={!results().length}>
                        <p class="specialist-caption">
                          {state.catalogLoading
                            ? "Loading…"
                            : "No matching capabilities. Install skills or configure connectors in Settings."}
                        </p>
                      </Show>
                    </div>
                    <Show when={results().length === 100}>
                      <p class="specialist-caption">Showing 100 matches. Refine your search to find more.</p>
                    </Show>
                  </div>
                </Show>
              </Show>
            </div>
          )}
        </For>
      </section>
      <div class="specialist-editor-footer">
        <FormButton label="Cancel" variant="ghost" disabled={state.writing} onClick={props.cancel} />
        <Show when={!readonly()}>
          <button type="submit" class="settings-button" data-variant="primary" disabled={state.writing}>
            {state.writing ? "Saving…" : state.editor?.name ? "Save changes" : "Create specialist"}
          </button>
        </Show>
      </div>
    </form>
  )
}
