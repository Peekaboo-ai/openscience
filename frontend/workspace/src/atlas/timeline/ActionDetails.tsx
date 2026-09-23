import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { For, Show, createMemo } from "solid-js"
import type { TimelineViewProps } from "./TimelineView"
import { duration, formatDuration, type Entry } from "./model"
import { present, statusHint } from "./presentation"

const exact = (value?: number) => (value === undefined ? "—" : new Date(value).toISOString().replace("T", " "))

export function ActionDetails(props: TimelineViewProps & { entry: Entry; now: number; close: () => void }) {
  const label = createMemo(() => present(props.entry, props.t, props.catalog))
  const ready = () => !props.mutation && !props.data.error && props.data.pages[0]?.status === "idle"
  const t = props.t
  return (
    <section
      id="timeline-action-details"
      class="action-timeline__card action-timeline__details"
      aria-label={t("Action details", "行动详情")}
    >
      <header class="action-timeline__heading">
        <div class="action-timeline__detail-title">
          <Icon name={label().icon} />
          <h3>{label().title}</h3>
          <span class="action-timeline__badge" data-status={props.entry.status}>
            {label().status}
          </span>
        </div>
        <Button size="small" variant="ghost" onClick={props.close}>
          {t("Close details", "关闭详情")}
        </Button>
      </header>
      <p class="action-timeline__detail-subtitle">
        {props.entry.kind === "user" ? props.entry.title : label().subtitle}
      </p>
      <Show when={statusHint(props.entry, t)}>
        {(hint) => (
          <p class="action-timeline__notice" data-status={props.entry.status}>
            <Icon name="alert-circle" size="small" />
            {hint()}
          </p>
        )}
      </Show>
      <dl>
        <dt>{t("Duration", "耗时")}</dt>
        <dd>{formatDuration(duration(props.entry, props.now))}</dd>
        <Show when={props.entry.kind === "inference"}>
          <dt>{t("Recorded cost", "已记录费用")}</dt>
          <dd>{props.entry.cost === undefined ? t("Not reported", "未报告") : `$${props.entry.cost.toFixed(6)}`}</dd>
        </Show>
        <Show when={props.entry.resources.length}>
          <dt>{t("Related resources", "关联资源")}</dt>
          <dd>{props.entry.resources.join(", ")}</dd>
        </Show>
        <Show when={props.entry.artifacts.length}>
          <dt>{t("Research artifacts", "研究成果")}</dt>
          <dd>{props.entry.artifacts.join(", ")}</dd>
        </Show>
      </dl>
      <Show when={props.entry.tokens}>
        {(tokens) => (
          <>
            <h4>{t("Token usage", "Token 用量")}</h4>
            <div class="action-timeline__usage">
              <For
                each={
                  [
                    [t("Input", "输入"), tokens().input],
                    [t("Output", "输出"), tokens().output],
                    [t("Reasoning", "推理"), tokens().reasoning],
                    [t("Cache read", "缓存读取"), tokens().cacheRead],
                    [t("Cache write", "缓存写入"), tokens().cacheWrite],
                  ] as const
                }
              >
                {([name, value]) => (
                  <div>
                    <small>{name}</small>
                    <strong>{value.toLocaleString()}</strong>
                  </div>
                )}
              </For>
            </div>
            <small>
              {t(
                "Reasoning is included in output. Cost is the stored estimate; zero may mean pricing is unavailable.",
                "推理用量包含在输出中。费用来自已记录的估算值；零费用也可能表示未配置价格。",
              )}
            </small>
          </>
        )}
      </Show>
      <details>
        <summary>{t("Recorded timestamps (UTC)", "记录时刻（UTC）")}</summary>
        <dl>
          <dt>{t("Queued", "入队")}</dt>
          <dd>{exact(props.entry.queuedAt)}</dd>
          <dt>{t("Started", "开始")}</dt>
          <dd>{exact(props.entry.startedAt)}</dd>
          <dt>{t("First response", "首响应")}</dt>
          <dd>{exact(props.entry.responseAt)}</dd>
          <dt>{t("Finished", "结束")}</dt>
          <dd>{exact(props.entry.completedAt)}</dd>
        </dl>
        <small>
          {t("Unavailable measurements appear as —; they are not estimated.", "未记录的数据以 — 表示，不作推算。")}
        </small>
      </details>
      <details>
        <summary>{t("Technical identifiers", "技术标识（排查用）")}</summary>
        <dl>
          <dt>{t("Action ID", "行动编号")}</dt>
          <dd>
            <code>{props.entry.id}</code>
          </dd>
          <dt>{t("Message ID", "消息编号")}</dt>
          <dd>
            <code>{props.entry.messageID}</code>
          </dd>
          <dt>{t("Request ID", "请求编号")}</dt>
          <dd>
            <code>{props.entry.turnID}</code>
          </dd>
          <dt>{t("Recorded type / status", "记录类型 / 状态")}</dt>
          <dd>
            {props.entry.kind} / {props.entry.status}
          </dd>
          <dt>{t("Agent", "执行代理")}</dt>
          <dd>{props.entry.owner}</dd>
          <Show when={props.entry.provider}>
            <dt>{t("Provider ID", "供应商编号")}</dt>
            <dd>
              <code>{props.entry.provider}</code>
            </dd>
          </Show>
          <Show when={props.entry.model}>
            <dt>{t("Model ID", "模型标识")}</dt>
            <dd>
              <code>{props.entry.model}</code>
            </dd>
          </Show>
          <Show when={props.entry.tool}>
            <dt>{t("Tool ID", "工具标识")}</dt>
            <dd>
              <code>{props.entry.tool}</code>
            </dd>
          </Show>
          <Show when={props.entry.executionID}>
            <dt>{t("Execution ID", "执行记录编号")}</dt>
            <dd>
              <code>{props.entry.executionID}</code>
            </dd>
            <dt>{t("Kernel generation", "内核代次")}</dt>
            <dd>{props.entry.generation ?? "—"}</dd>
          </Show>
        </dl>
      </details>
      <div class="action-timeline__detail-actions">
        <small>
          {t(
            "These operations use the message boundary, which may contain several steps.",
            "以下操作作用于整条消息边界，该消息可能包含多个步骤。",
          )}
        </small>
        <div class="action-timeline__buttons">
          <Button size="small" variant="ghost" disabled={!ready()} onClick={() => props.fork(props.entry.messageID)}>
            {t("Fork before this message", "从此消息之前分支")}
          </Button>
          <Button size="small" variant="ghost" disabled={!ready()} onClick={() => props.revert(props.entry.messageID)}>
            {t("Undo from this message", "从此消息撤销")}
          </Button>
          <Show when={props.entry.childSessionID}>
            {(id) => (
              <Button size="small" variant="ghost" onClick={() => props.openSession(id())}>
                {t("Open child session", "打开子会话")}
              </Button>
            )}
          </Show>
        </div>
      </div>
    </section>
  )
}
