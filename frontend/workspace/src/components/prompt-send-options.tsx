import { DropdownMenu } from "@synsci/ui/dropdown-menu"
import { Icon } from "@synsci/ui/icon"

export function PromptSendOptions(props: {
  disabled: boolean
  locale: string
  send: (delivery: "guide" | "queue") => void
}) {
  const t = (en: string, zh: string) => (props.locale.startsWith("zh") ? zh : en)
  return (
    <DropdownMenu placement="top-end">
      <DropdownMenu.Trigger
        type="button"
        class="workspace-composer__send-options"
        disabled={props.disabled}
        aria-label={t("Send options", "发送选项")}
        title={t("Send options", "发送选项")}
      >
        <Icon name="chevron-down" size="small" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content>
          <DropdownMenu.Item onSelect={() => props.send("guide")}>
            <DropdownMenu.ItemLabel>{t("Guide current task", "引导当前任务")}</DropdownMenu.ItemLabel>
            <DropdownMenu.ItemDescription>{t("Send now · Enter", "立即发送 · Enter")}</DropdownMenu.ItemDescription>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => props.send("queue")}>
            <DropdownMenu.ItemLabel>{t("Add to queue", "加入队列")}</DropdownMenu.ItemLabel>
            <DropdownMenu.ItemDescription>
              {t("Run after this task · Ctrl/⌘ + Enter", "当前任务完成后执行 · Ctrl/⌘ + Enter")}
            </DropdownMenu.ItemDescription>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
