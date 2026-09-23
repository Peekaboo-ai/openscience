import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { RuntimeQueueSnapshot, OpenScienceClient } from "@synsci/sdk/v2/client"
import { Button } from "@synsci/ui/button"
import { IconButton } from "@synsci/ui/icon-button"
import { requestFailure } from "@/utils/request-error"
import "./prompt-queue.css"

type Change = NonNullable<Parameters<OpenScienceClient["runtime"]["updateQueue"]>[0]>["change"]

export function PromptQueue(props: {
  client: OpenScienceClient
  sessionID?: string
  refresh: number
  working: boolean
  locale: string
  onAvailable: (available: boolean) => void
}) {
  const t = (en: string, zh: string) => (props.locale.startsWith("zh") ? zh : en)
  const [state, setState] = createStore<{
    snapshot?: RuntimeQueueSnapshot
    error?: string
    busy: boolean
    editing?: string
    text: string
    editRevision: number
  }>({ busy: false, text: "", editRevision: 0 })
  let scope = 0
  let deleted: { client: OpenScienceClient; sessionID: string } | undefined
  const accept = (snapshot?: RuntimeQueueSnapshot) => {
    if (!snapshot) return
    if (state.snapshot?.sessionID === snapshot.sessionID && state.snapshot.revision > snapshot.revision) return
    // 保留相同消息的节点与编辑选区，并拒绝覆盖较新操作的迟到轮询结果。
    setState("snapshot", reconcile(snapshot, { key: "id" }))
  }
  createEffect(() => {
    const client = props.client
    const sessionID = props.sessionID
    if (deleted?.client === client && deleted.sessionID === sessionID) return
    props.refresh
    props.working
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let supported = false
    if (!sessionID) {
      setState("snapshot", undefined)
      return
    }
    const refresh = async () => {
      try {
        if (!supported) {
          const result = await client.runtime.capabilities({}, { signal: controller.signal })
          supported = result.data?.promptQueue === true
          if (!supported) return
          props.onAvailable(true)
        }
        const result = await client.runtime.queue({ sessionID }, { throwOnError: false, signal: controller.signal })
        if (controller.signal.aborted) return
        // 已删除会话是终态；继续轮询只会制造错误风暴。
        if ([404, 410].includes(result.response?.status ?? 0)) {
          deleted = { client, sessionID }
          supported = false
          props.onAvailable(false)
          setState({ snapshot: undefined, error: undefined })
          return
        }
        if (result.error) throw result.error
        accept(result.data)
        setState("error", undefined)
      } catch (error) {
        if (!controller.signal.aborted && supported)
          setState("error", requestFailure(error, "Read prompt queue").description)
      } finally {
        if (!controller.signal.aborted && supported)
          timer = setTimeout(refresh, props.working || state.snapshot?.items.length ? 2000 : 10_000)
      }
    }
    void refresh()
    onCleanup(() => {
      controller.abort()
      clearTimeout(timer)
    })
  })
  createEffect(() => {
    props.sessionID
    props.client
    scope++
    props.onAvailable(false)
    setState({ snapshot: undefined, error: undefined, editing: undefined, text: "", busy: false })
  })
  const mutate = async (change: Change, revision = state.snapshot?.revision) => {
    const sessionID = props.sessionID
    const client = props.client
    const current = scope
    if (!sessionID || revision === undefined || state.busy) return
    setState({ busy: true, error: undefined })
    try {
      const result = await client.runtime.updateQueue({ sessionID, revision, change }, { throwOnError: true })
      if (scope === current) {
        accept(result.data)
        setState("editing", undefined)
      }
    } catch (error) {
      if (scope === current) setState("error", requestFailure(error, "Update prompt queue").description)
    } finally {
      if (scope === current) setState("busy", false)
    }
  }
  const text = (item: RuntimeQueueSnapshot["items"][number]) =>
    item.input.message ?? item.input.parts?.find((part) => part.type === "text")?.text ?? ""
  const reason = () => {
    const reason = state.snapshot?.reason
    if (reason === "runtime_restarted")
      return t("Server restarted. Review pending messages before resuming.", "服务已重启，请检查待发送内容后继续。")
    if (reason && reason !== "user")
      return t("The previous task stopped or failed. Resume when ready.", "上一任务已停止或失败，准备好后可继续队列。")
    return t("Paused", "已暂停")
  }
  return (
    <Show when={state.snapshot?.items.length || state.error}>
      <section class="prompt-queue" aria-label={t("Queued messages", "待发送消息")}>
        <div class="prompt-queue__header">
          <span class="prompt-queue__title">
            {t("Queued messages", "待发送消息")} · {state.snapshot?.items.length ?? 0}
          </span>
          <Show when={state.snapshot?.items.length}>
            <Button
              variant="ghost"
              size="small"
              disabled={state.busy}
              onClick={() => void mutate({ type: state.snapshot?.paused ? "resume" : "pause" })}
            >
              {state.snapshot?.paused ? t("Resume queue", "继续队列") : t("Pause queue", "暂停队列")}
            </Button>
          </Show>
        </div>
        <Show when={state.snapshot?.paused}>
          <p class="prompt-queue__hint">{reason()}</p>
        </Show>
        <Show when={state.error}>
          <p class="prompt-queue__error" role="alert">
            {state.error}
          </p>
        </Show>
        <ol class="prompt-queue__items">
          <For each={state.snapshot?.items}>
            {(item, index) => (
              <li class="prompt-queue__item">
                <span class="prompt-queue__number">{index() + 1}</span>
                <div class="prompt-queue__body">
                  <Show
                    when={state.editing === item.id}
                    fallback={
                      <p class="prompt-queue__text" title={text(item)}>
                        {text(item) || t("Attachments", "附件")}
                      </p>
                    }
                  >
                    <textarea
                      aria-label={t("Edit queued message", "编辑待发送消息")}
                      value={state.text}
                      onInput={(event) => setState("text", event.currentTarget.value)}
                    />
                    <div class="prompt-queue__controls">
                      <Button
                        size="small"
                        disabled={state.busy || !state.text.trim()}
                        onClick={() => void mutate({ type: "edit", id: item.id, text: state.text }, state.editRevision)}
                      >
                        {t("Save", "保存")}
                      </Button>
                      <Button size="small" variant="ghost" onClick={() => setState("editing", undefined)}>
                        {t("Cancel", "取消")}
                      </Button>
                    </div>
                  </Show>
                  <div class="prompt-queue__hint">
                    {[
                      item.input.model?.modelID,
                      item.input.variant,
                      (item.input.parts?.filter((part) => part.type !== "text").length ?? 0) > 0
                        ? t("Includes attachments", "包含附件")
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <div class="prompt-queue__controls">
                  <IconButton
                    icon="arrow-up"
                    variant="ghost"
                    disabled={state.busy || index() === 0}
                    aria-label={t("Move up", "上移")}
                    onClick={() =>
                      void mutate({ type: "move", id: item.id, before: state.snapshot!.items[index() - 1]!.id })
                    }
                  />
                  <IconButton
                    icon="arrow-up"
                    class="rotate-180"
                    variant="ghost"
                    disabled={state.busy || index() === (state.snapshot?.items.length ?? 0) - 1}
                    aria-label={t("Move down", "下移")}
                    onClick={() =>
                      void mutate({ type: "move", id: item.id, before: state.snapshot?.items[index() + 2]?.id ?? null })
                    }
                  />
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={state.busy}
                    onClick={() =>
                      setState({ editing: item.id, text: text(item), editRevision: state.snapshot!.revision })
                    }
                  >
                    {t("Edit", "编辑")}
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={state.busy}
                    onClick={() => void mutate({ type: "remove", id: item.id })}
                  >
                    {t("Remove", "移除")}
                  </Button>
                </div>
              </li>
            )}
          </For>
        </ol>
      </section>
    </Show>
  )
}
