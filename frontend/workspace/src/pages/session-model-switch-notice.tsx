import { createMemo } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import { Tooltip } from "@synsci/ui/tooltip"
import { useLanguage } from "@/context/language"
import { modelSwitchLabels, type ModelSwitch } from "./session-model-switch"
import "./session-model-switch.css"

export function ModelSwitchNotice(props: {
  change: ModelSwitch
  providers: Parameters<typeof modelSwitchLabels>[1]
  pending?: boolean
}) {
  const language = useLanguage()
  const labels = createMemo(() => modelSwitchLabels(props.change, props.providers))
  const description = () =>
    language.t(props.pending ? "session.modelSwitch.nextMessage" : "session.modelSwitch.history")
  return (
    <div
      class="session-model-switch"
      data-pending={props.pending ? "true" : undefined}
      data-component="model-switch-notice"
    >
      <span class="session-model-switch__rule" aria-hidden="true" />
      <div class="session-model-switch__content">
        <Icon name="models" size="small" />
        <span
          class="session-model-switch__label"
          role={props.pending ? "status" : undefined}
          aria-atomic={props.pending ? "true" : undefined}
        >
          {language.t("session.modelSwitch.changed", { from: labels().from, to: labels().to })}
        </span>
        <Tooltip
          value={
            <>
              <span>{labels().detail}</span>
              <br />
              <span>{description()}</span>
            </>
          }
        >
          <button
            type="button"
            class="session-model-switch__info"
            aria-label={language.t("session.modelSwitch.details")}
          >
            <Icon name="help" size="small" />
          </button>
        </Tooltip>
      </div>
      <span class="session-model-switch__rule" aria-hidden="true" />
    </div>
  )
}
