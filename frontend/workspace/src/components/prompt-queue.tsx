import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { RuntimeQueueSnapshot, OpenScienceClient } from "@synsci/sdk/v2/client"
import { Button } from "@synsci/ui/button"
import { DropdownMenu } from "@synsci/ui/dropdown-menu"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { requestDeadline } from "@/utils/request-deadline"
import { requestFailure } from "@/utils/request-error"
import { createQueueDrag } from "./prompt-queue-drag"
import "./prompt-queue.css"

type Change = NonNullable<Parameters<OpenScienceClient["runtime"]["updateQueue"]>[0]>["change"]
const REQUEST_TIMEOUT = 30_000

export function PromptQueue(props: {
  client: OpenScienceClient
  sessionID?: string
  refresh: number
  working: boolean
  runID?: string
  locale: string
  onAvailable: (available: boolean) => void
  onGuided?: () => void
}) {
  const t = (en: string, zh: string) => (props.locale.startsWith("zh") ? zh : en)
  const [state, setState] = createStore<{
    snapshot?: RuntimeQueueSnapshot
    error?: string
    readError?: string
    busy: boolean
    retry: number
    editing?: string
    text: string
    editBase: string
    editRevision: number
    announcement?: string
  }>({ busy: false, retry: 0, text: "", editBase: "", editRevision: 0 })
  let scope = 0
  let mutation: AbortController | undefined
  let deleted: { client: OpenScienceClient; sessionID: string } | undefined
  let capability: { client: OpenScienceClient; supported: boolean } | undefined
  const text = (item: RuntimeQueueSnapshot["items"][number]) =>
    item.input.message ?? item.input.parts?.find((part) => part.type === "text")?.text ?? ""
  const accept = (snapshot?: RuntimeQueueSnapshot) => {
    if (!snapshot || snapshot.sessionID !== props.sessionID) return
    if (state.snapshot?.sessionID === snapshot.sessionID && state.snapshot.revision > snapshot.revision) return
    const editing = snapshot.items.find((item) => item.id === state.editing)
    // 其他消息的增删或排序不应锁死编辑；同一条正文被改动时仍保留冲突保护。
    if (editing && text(editing) === state.editBase) setState("editRevision", snapshot.revision)
    // 按消息标识保留编辑器节点、焦点和选区，迟到的轮询不能覆盖新操作。
    setState("snapshot", reconcile(snapshot, { key: "id" }))
  }
  createEffect(() => {
    props.sessionID
    props.client
    scope++
    drag.cancel()
    mutation?.abort()
    props.onAvailable(false)
    setState({ snapshot: undefined, error: undefined, readError: undefined, editing: undefined, text: "", busy: false })
  })
  createEffect(() => {
    const client = props.client
    const sessionID = props.sessionID
    props.refresh
    props.working
    state.retry
    // new 是草稿路由；不存在的会话和已删除会话都不应反复探测队列。
    if (!sessionID || sessionID === "new" || (deleted?.client === client && deleted.sessionID === sessionID)) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let terminal = false
    const owns = () => !controller.signal.aborted && props.client === client && props.sessionID === sessionID
    const refresh = async () => {
      try {
        if (capability?.client !== client) {
          const result = await requestDeadline(
            (signal) => client.runtime.capabilities({}, { throwOnError: false, signal }),
            REQUEST_TIMEOUT,
            controller.signal,
          )
          if (!owns()) return
          if ([404, 410].includes(result.response?.status ?? 0)) {
            capability = { client, supported: false }
            terminal = true
            props.onAvailable(false)
            setState({ snapshot: undefined, error: undefined, readError: undefined })
            return
          }
          if (result.error) throw result.error
          if (!result.data)
            throw new Error(
              t("The server capabilities response was empty. Please retry.", "未收到服务器能力信息，请重试。"),
            )
          capability = { client, supported: result.data?.promptQueue === true }
        }
        props.onAvailable(capability.supported)
        if (!capability.supported) {
          terminal = true
          return
        }
        const result = await requestDeadline(
          (signal) => client.runtime.queue({ sessionID }, { throwOnError: false, signal }),
          REQUEST_TIMEOUT,
          controller.signal,
        )
        if (!owns()) return
        if ([404, 410].includes(result.response?.status ?? 0)) {
          deleted = { client, sessionID }
          terminal = true
          props.onAvailable(false)
          setState({ snapshot: undefined, error: undefined, readError: undefined })
          return
        }
        if (result.error) throw result.error
        if (!result.data) throw new Error(t("The queue response was empty. Please retry.", "未收到队列内容，请重试。"))
        accept(result.data)
        failures = 0
        setState("readError", undefined)
      } catch (error) {
        if (!owns()) return
        failures++
        setState("readError", requestFailure(error, "Read prompt queue").description)
      } finally {
        // 首次能力探测失败和传输超时也要重试；后台刷新不能清掉用户编辑的错误信息。
        if (owns() && !terminal)
          timer = setTimeout(
            refresh,
            failures
              ? Math.min(1000 * 2 ** Math.min(failures - 1, 4), 10_000)
              : props.working || state.snapshot?.items.length
                ? 2000
                : 10_000,
          )
      }
    }
    void refresh()
    onCleanup(() => {
      controller.abort()
      clearTimeout(timer)
    })
  })
  onCleanup(() => {
    scope++
    mutation?.abort()
  })
  const runID = () => props.runID ?? state.snapshot?.activeRunID
  const locked = (id: string) => state.busy || state.snapshot?.dispatching === id
  const mutate = async (change: Change, revision = state.snapshot?.revision) => {
    const sessionID = props.sessionID
    const client = props.client
    const current = scope
    if (!sessionID || sessionID === "new" || revision === undefined || state.busy) return false
    if ("id" in change && state.snapshot?.dispatching === change.id) return false
    if (change.type === "guide" && (!props.working || !runID() || change.runID !== runID())) return false
    const controller = new AbortController()
    mutation = controller
    const owns = () =>
      scope === current && !controller.signal.aborted && props.client === client && props.sessionID === sessionID
    setState({ busy: true, error: undefined })
    try {
      const result = await requestDeadline(
        (signal) => client.runtime.updateQueue({ sessionID, revision, change }, { throwOnError: true, signal }),
        REQUEST_TIMEOUT,
        controller.signal,
      )
      if (!owns()) return false
      if (!result.data) throw new Error(t("The queue response was empty. Please refresh.", "未收到队列内容，请刷新。"))
      accept(result.data)
      if ("id" in change && change.id === state.editing && ["edit", "remove", "guide"].includes(change.type))
        setState("editing", undefined)
      if (change.type === "guide") props.onGuided?.()
      return true
    } catch (error) {
      if (owns()) {
        setState("error", requestFailure(error, "Update prompt queue").description)
        setState("retry", (value) => value + 1)
      }
      return false
    } finally {
      if (owns()) setState("busy", false)
      if (mutation === controller) mutation = undefined
    }
  }
  const reason = () => {
    const reason = state.snapshot?.reason
    if (reason === "runtime_restarted")
      return t("Server restarted. Review pending messages before resuming.", "服务已重启，请检查待发送内容后继续。")
    if (reason === "session_busy")
      return t(
        "After the current command finishes, resume these queued messages.",
        "当前命令结束后，点击继续处理排队消息。",
      )
    if (reason === "submission_failed")
      return t(
        "A queued message could not be sent. Review it before resuming the queue.",
        "排队消息未能发送，请检查内容后继续队列。",
      )
    if (reason && reason !== "user")
      return t("The previous task stopped or failed. Resume when ready.", "上一任务已停止或失败，准备好后可继续队列。")
    return t("Queue paused", "队列已暂停")
  }
  const retry = () => {
    capability = undefined
    setState("error", undefined)
    setState("retry", (value) => value + 1)
  }
  const drag = createQueueDrag({
    items: () => state.snapshot?.items ?? [],
    revision: () => state.snapshot?.revision,
    session: () => props.sessionID,
    disabled: () => state.busy || !!state.editing || !!state.snapshot?.dispatching,
    async move(id, before, revision) {
      const focused = document.activeElement
      if (!(await mutate({ type: "move", id, before }, revision))) return
      // 原生浏览器会在提交期间禁用按钮时移走焦点；仅在焦点仍为空时恢复，支持连续键盘排序。
      if (
        focused instanceof HTMLElement &&
        focused.matches(".prompt-queue__drag") &&
        focused.isConnected &&
        document.activeElement === document.body
      )
        focused.focus()
      const position = (state.snapshot?.items.findIndex((item) => item.id === id) ?? -1) + 1
      if (position > 0)
        setState("announcement", t(`Message moved to position ${position}.`, `消息已移至第 ${position} 位。`))
    },
  })
  const dropEnd = () => state.snapshot?.items.filter((item) => item.id !== drag.state.id).at(-1)?.id
  return (
    <Show when={state.snapshot?.items.length || state.error || state.readError}>
      <section class="prompt-queue" aria-label={t("Queued messages", "待发送消息")}>
        <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {state.announcement}
        </span>
        <Show when={!state.snapshot?.paused && state.snapshot?.items.length}>
          <div
            class="prompt-queue__status"
            data-compact={state.snapshot?.items.length === 1 || undefined}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {t(`Queued · ${state.snapshot?.items.length}`, `待执行 · ${state.snapshot?.items.length}`)}
            <span>{t("Runs after the current task", "当前任务结束后依次执行")}</span>
          </div>
        </Show>
        <Show when={state.snapshot?.paused && state.snapshot.items.length}>
          <div class="prompt-queue__notice">
            <span>{reason()}</span>
            <Button variant="ghost" size="small" disabled={state.busy} onClick={() => void mutate({ type: "resume" })}>
              {t("Resume queue", "继续队列")}
            </Button>
          </div>
        </Show>
        <Show when={state.error || state.readError}>
          <div class="prompt-queue__notice prompt-queue__error" role="alert">
            <span>{state.error || state.readError}</span>
            <Button variant="ghost" size="small" disabled={state.busy} onClick={retry}>
              {t("Refresh queue", "刷新队列")}
            </Button>
          </div>
        </Show>
        <ol ref={drag.ref} class="prompt-queue__items">
          <For each={state.snapshot?.items}>
            {(item, index) => {
              let editor: HTMLTextAreaElement | undefined
              let menu: HTMLButtonElement | undefined
              let editButton: HTMLButtonElement | undefined
              const [menuOpen, setMenuOpen] = createSignal(false)
              const attachments = () =>
                [
                  (item.input.parts?.filter((part) => part.type !== "text").length ?? 0) > 0
                    ? t("Includes attachments", "包含附件")
                    : undefined,
                  (item.input.parts?.filter((part) => part.type === "text").length ?? 0) >
                  (item.input.message === undefined ? 1 : 0)
                    ? t("Includes additional context", "包含附加上下文")
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")
              const details = () =>
                [item.input.model?.modelID, item.input.variant, attachments()].filter(Boolean).join(" · ")
              const conflict = () => state.editing === item.id && text(item) !== state.editBase
              const edit = () => {
                setMenuOpen(false)
                const base = text(item)
                setState({ editing: item.id, text: base, editBase: base, editRevision: state.snapshot!.revision })
                queueMicrotask(() => editor?.focus())
              }
              const finishEdit = () => {
                setState("editing", undefined)
                editButton?.focus()
              }
              return (
                <li
                  class="prompt-queue__item"
                  data-queue-id={item.id}
                  data-editing={state.editing === item.id || undefined}
                  data-dragging={(drag.state.active && drag.state.id === item.id) || undefined}
                  data-drop-before={
                    (drag.state.active && drag.state.inside && drag.state.before === item.id) || undefined
                  }
                  data-drop-after={
                    (drag.state.active && drag.state.inside && drag.state.before === null && dropEnd() === item.id) ||
                    undefined
                  }
                  style={{
                    transform:
                      drag.state.active && drag.state.id === item.id ? `translateY(${drag.state.offset}px)` : undefined,
                  }}
                >
                  <IconButton
                    icon="dot-grid"
                    variant="ghost"
                    class="prompt-queue__drag"
                    aria-label={t(`Reorder message ${index() + 1}`, `调整第 ${index() + 1} 条消息顺序`)}
                    aria-keyshortcuts="ArrowUp ArrowDown"
                    title={t("Drag to reorder, or use ↑ / ↓", "拖动调整顺序，或使用 ↑ / ↓")}
                    disabled={
                      locked(item.id) ||
                      !!state.editing ||
                      !!state.snapshot?.dispatching ||
                      state.snapshot!.items.length < 2
                    }
                    onPointerDown={(event) => drag.start(event, item.id)}
                    onPointerMove={drag.update}
                    onPointerUp={drag.finish}
                    onPointerCancel={drag.cancel}
                    onLostPointerCapture={drag.cancel}
                    onKeyDown={(event) => drag.key(event, item.id)}
                  />
                  <div class="prompt-queue__body">
                    <Show
                      when={state.editing === item.id}
                      fallback={
                        <p class="prompt-queue__text" title={[text(item), details()].filter(Boolean).join("\n")}>
                          {text(item) || t("Attachments", "附件")}
                        </p>
                      }
                    >
                      <textarea
                        ref={editor}
                        aria-label={t("Edit queued message", "编辑待发送消息")}
                        value={state.text}
                        onInput={(event) => setState("text", event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape" || state.busy) return
                          event.preventDefault()
                          finishEdit()
                        }}
                      />
                      <Show when={conflict()}>
                        <div class="prompt-queue__conflict" role="status">
                          <span>
                            {t(
                              "This message changed in another window. Choose which version to keep.",
                              "此消息已在其他窗口修改，请选择要保留的版本。",
                            )}
                          </span>
                          <div class="prompt-queue__controls">
                            <Button size="small" variant="ghost" disabled={state.busy} onClick={edit}>
                              {t("Load latest", "载入最新内容")}
                            </Button>
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={state.busy}
                              onClick={() =>
                                setState({
                                  editBase: text(item),
                                  editRevision: state.snapshot!.revision,
                                  error: undefined,
                                })
                              }
                            >
                              {t("Keep my changes", "保留我的修改")}
                            </Button>
                          </div>
                        </div>
                      </Show>
                      <div class="prompt-queue__controls">
                        <Button
                          size="small"
                          disabled={locked(item.id) || !state.text.trim() || conflict()}
                          onClick={async () => {
                            if (await mutate({ type: "edit", id: item.id, text: state.text }, state.editRevision))
                              editButton?.focus()
                          }}
                        >
                          {t("Save", "保存")}
                        </Button>
                        <Button size="small" variant="ghost" disabled={state.busy} onClick={finishEdit}>
                          {t("Cancel", "取消")}
                        </Button>
                      </div>
                    </Show>
                    <div class="prompt-queue__hint">{state.editing === item.id ? details() : attachments()}</div>
                  </div>
                  <div class="prompt-queue__actions">
                    <Button
                      size="small"
                      variant="secondary"
                      class="prompt-queue__guide"
                      aria-label={t("Steer current task", "引导当前任务")}
                      title={
                        props.working && runID()
                          ? t("Use this message to guide the current task", "用此消息补充当前任务的指令")
                          : t("Available when a supported task is running", "支持引导的任务运行时可用")
                      }
                      disabled={
                        locked(item.id) ||
                        !!state.snapshot?.dispatching ||
                        !props.working ||
                        !runID() ||
                        state.editing === item.id
                      }
                      onClick={() => void mutate({ type: "guide", id: item.id, runID: runID()! })}
                    >
                      <Icon name="arrow-down-to-line" size="small" class="prompt-queue__guide-icon" />
                      {state.snapshot?.dispatching === item.id ? t("Sending…", "发送中…") : t("Steer", "引导")}
                    </Button>
                    <IconButton
                      ref={editButton}
                      icon="edit"
                      variant="ghost"
                      disabled={locked(item.id) || state.editing === item.id}
                      aria-label={t("Edit message", "编辑消息")}
                      title={t("Edit message", "编辑消息")}
                      onClick={edit}
                    />
                    <IconButton
                      icon="trash"
                      variant="ghost"
                      disabled={locked(item.id)}
                      aria-label={t("Remove queued message", "移除待发送消息")}
                      title={t("Remove queued message", "移除待发送消息")}
                      onClick={() => void mutate({ type: "remove", id: item.id })}
                    />
                    <DropdownMenu placement="top-end" open={menuOpen()} onOpenChange={setMenuOpen}>
                      <DropdownMenu.Trigger
                        ref={menu}
                        type="button"
                        class="prompt-queue__more"
                        disabled={locked(item.id)}
                        aria-label={t("More queue actions", "更多队列操作")}
                        title={t("More queue actions", "更多队列操作")}
                      >
                        <Icon name="more-horizontal" size="small" />
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          onCloseAutoFocus={(event) => {
                            if (state.editing === item.id) {
                              event.preventDefault()
                              queueMicrotask(() => editor?.focus())
                            }
                          }}
                        >
                          <DropdownMenu.Item disabled={locked(item.id)} onSelect={edit}>
                            <Icon name="edit" size="small" />
                            <DropdownMenu.ItemLabel>{t("Edit message", "编辑消息")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            disabled={locked(item.id) || index() === 0}
                            onSelect={() =>
                              void mutate({ type: "move", id: item.id, before: state.snapshot!.items[index() - 1]!.id })
                            }
                          >
                            <Icon name="arrow-up" size="small" />
                            <DropdownMenu.ItemLabel>{t("Move up", "上移")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            disabled={locked(item.id) || index() === (state.snapshot?.items.length ?? 0) - 1}
                            onSelect={() =>
                              void mutate({
                                type: "move",
                                id: item.id,
                                before: state.snapshot?.items[index() + 2]?.id ?? null,
                              })
                            }
                          >
                            <Icon name="arrow-up" size="small" class="rotate-180" />
                            <DropdownMenu.ItemLabel>{t("Move down", "下移")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator />
                          <DropdownMenu.Item
                            disabled={state.busy}
                            onSelect={() => void mutate({ type: state.snapshot?.paused ? "resume" : "pause" })}
                          >
                            <DropdownMenu.ItemLabel>
                              {state.snapshot?.paused ? t("Resume queue", "继续队列") : t("Pause queue", "暂停队列")}
                            </DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu>
                  </div>
                </li>
              )
            }}
          </For>
        </ol>
      </section>
    </Show>
  )
}
