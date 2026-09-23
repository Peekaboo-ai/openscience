import { Show, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useDialog } from "@synsci/ui/context/dialog"
import { confirmDialog, promptDialog } from "@/atlas/dialogs"
import type { TimelineRecoveryPlan, TimelineRevertPreview } from "@synsci/sdk/v2/client"
import { uiStore } from "@/atlas/store/ui"
import { createTimelineController, json, type Snapshot } from "./controller"
import { TimelineView } from "./TimelineView"

export function ActionTimelinePane(props: { sessionID?: string; active: boolean }) {
  const sdk = useSDK()
  const language = useLanguage()
  const sync = useSync()
  const dialog = useDialog()
  const navigate = useNavigate()
  const params = useParams()
  const t = (en: string, zh: string) => (language.locale().startsWith("zh") ? zh : en)
  return (
    <Show
      when={props.sessionID && props.sessionID !== "new" ? props.sessionID : undefined}
      keyed
      fallback={
        <p class="action-timeline__empty">
          {t("Open a session to inspect its actions.", "打开会话以查看行动时间线。")}
        </p>
      }
    >
      {(sessionID) => {
        const [state, setState] = createStore<{
          data: Snapshot
          mutation: string
          actionError: string
          recoveryPlan?: TimelineRecoveryPlan
        }>({
          data: { pages: [], entries: [], loading: true, error: "", workbenchError: "" },
          mutation: "",
          actionError: "",
        })
        const scope = sdk.scope
        let alive = true
        const current = () => alive && sdk.scope === scope && props.sessionID === sessionID
        const controller = createTimelineController(sessionID, sdk.request, (data) => {
          if (current()) setState("data", data)
        })
        const openSession = (id: string) => navigate(`/${params.dir}/session/${encodeURIComponent(id)}`)
        let scheduled: ReturnType<typeof setTimeout> | undefined
        const schedule = () => {
          if (!props.active || document.hidden || scheduled) return
          scheduled = setTimeout(() => {
            scheduled = undefined
            void controller.refresh()
          }, 500)
        }
        const subscriptions = [
          sdk.event.on("message.updated", (event) => {
            if (event.properties.info.sessionID === sessionID) schedule()
          }),
          sdk.event.on("message.part.updated", (event) => {
            if (event.properties.part.sessionID === sessionID) schedule()
          }),
          sdk.event.on("message.removed", (event) => {
            if (event.properties.sessionID === sessionID) schedule()
          }),
          sdk.event.on("session.status", (event) => {
            if (event.properties.sessionID === sessionID) schedule()
          }),
          sdk.event.on("session.updated", (event) => {
            if (event.properties.info.id === sessionID) schedule()
          }),
        ]
        createEffect(() => {
          if (props.active) void controller.refresh()
        })
        const timer = setInterval(schedule, 5000)
        document.addEventListener("visibilitychange", schedule)
        onCleanup(() => {
          alive = false
          controller.dispose()
          clearInterval(timer)
          clearTimeout(scheduled)
          subscriptions.forEach((unsubscribe) => unsubscribe())
          document.removeEventListener("visibilitychange", schedule)
        })
        const mutate = async (name: string, operation: () => Promise<void>) => {
          if (!current() || state.mutation) return
          setState({ mutation: name, actionError: "" })
          try {
            await operation()
            if (current()) await controller.refresh(true)
          } catch (error) {
            if (current()) setState("actionError", error instanceof Error ? error.message : String(error))
          } finally {
            if (current()) setState("mutation", "")
          }
        }
        const post = <T,>(path: string, body = {}) =>
          sdk
            .request(path, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
            .then(json<T>)
        const base = `/session/${encodeURIComponent(sessionID)}/action-timeline`
        return (
          <TimelineView
            sessionID={sessionID}
            active={props.active}
            data={state.data}
            t={t}
            catalog={sync.data.provider.all}
            mutation={state.mutation}
            actionError={state.actionError}
            recoveryPlan={state.recoveryPlan}
            previewRecovery={(id) =>
              void mutate("plan", async () => {
                const plan = await json<TimelineRecoveryPlan>(
                  await sdk.request(`${base}/recovery/${encodeURIComponent(id)}`),
                )
                if (current()) setState("recoveryPlan", plan)
              })
            }
            recover={(id) =>
              void mutate("recover", async () => {
                const confirmed = await confirmDialog(dialog, {
                  title: t("Recover into a fresh branch?", "恢复到全新分支？"),
                  message: t(
                    "Only the safe steps in this plan will run. Manual steps remain unresolved. Your source session and kernel are preserved.",
                    "仅执行计划中可安全重放的步骤，人工步骤不会自动执行。原会话和原内核将保留。",
                  ),
                  confirmLabel: t("Recover", "开始恢复"),
                })
                if (confirmed && current()) await post(`${base}/recovery/${encodeURIComponent(id)}`)
              })
            }
            forkCheckpoint={(id) =>
              void mutate("fork", async () => {
                const branch = await post<{ sessionID: string }>(`${base}/fork`, { checkpointID: id })
                if (current()) openSession(branch.sessionID)
              })
            }
            cancelRun={(id) =>
              void mutate("cancel", async () => {
                await post("/runtime/cancel", { sessionID, runID: id })
              })
            }
            cancelJob={(id) =>
              void mutate("cancel", async () => {
                if (
                  (await confirmDialog(dialog, {
                    title: t("Cancel compute job?", "取消计算任务？"),
                    message: t(
                      "The selected remote job will be stopped. Existing artifacts remain available.",
                      "将停止选中的远程计算任务，已有制品保留。",
                    ),
                    confirmLabel: t("Cancel job", "取消任务"),
                    danger: true,
                  })) &&
                  current()
                )
                  await post(`/settings/compute/jobs/${encodeURIComponent(id)}/cancel`)
              })
            }
            childControl={(id, operation) =>
              void mutate(operation, async () => {
                const text =
                  operation === "steer"
                    ? await promptDialog(dialog, {
                        title: t("Guide child agent", "引导子代理"),
                        message: t(
                          "Add instructions to the child's current execution loop.",
                          "向子代理当前执行循环追加指导。",
                        ),
                        placeholder: t("Instructions…", "输入指导…"),
                        confirmLabel: t("Send guidance", "发送指导"),
                      })
                    : undefined
                if (operation === "steer" && !text?.trim()) return
                if (
                  operation === "stop" &&
                  !(await confirmDialog(dialog, {
                    title: t("Stop child agent?", "停止子代理？"),
                    message: t("Completed work remains in the child session.", "已完成的工作会保留在子会话中。"),
                    confirmLabel: t("Stop", "停止"),
                    danger: true,
                  }))
                )
                  return
                if (current()) await post(`${base}/child/${encodeURIComponent(id)}`, { operation, text })
              })
            }
            refresh={() => void controller.refresh(true)}
            earlier={controller.earlier}
            openSession={openSession}
            checkpoint={() =>
              void mutate("checkpoint", async () => {
                await json(
                  await sdk.request(`/session/${encodeURIComponent(sessionID)}/action-timeline/checkpoint`, {
                    method: "POST",
                  }),
                )
              })
            }
            fork={(messageID) =>
              void mutate("fork", async () => {
                const result = await post<{ sessionID: string }>(`${base}/fork`, { messageID })
                if (current()) openSession(result.sessionID)
              })
            }
            revert={(messageID) =>
              void mutate("revert", async () => {
                const preview = await json<TimelineRevertPreview>(
                  await sdk.request(`${base}/revert-preview`, undefined, { messageID }),
                )
                const confirmed = await confirmDialog(dialog, {
                  title: t("Undo from this message?", "从此消息撤销？"),
                  message: `${preview.messages} ${t("messages", "条消息")} · ${preview.actions} ${t("actions", "个行动")} · ${preview.files.length} ${t("tracked files", "个受追踪文件")}\n${preview.files.join("\n")}\n${t("Kernel memory is not rewound. Restore is available before sending another message.", "内核内存不会回退。发送新消息前可恢复撤销内容。")}`,
                  confirmLabel: t("Undo", "撤销"),
                  danger: true,
                })
                if (!confirmed || !current()) return
                await sdk.client.session.revert({ sessionID, messageID })
              })
            }
            restore={() =>
              void mutate("restore", async () => {
                await sdk.client.session.unrevert({ sessionID })
              })
            }
            openCheckpoint={(path) => uiStore.openFile(sdk.directory, path)}
            restart={(kernelID) =>
              void mutate("restart", async () => {
                const confirmed = await confirmDialog(dialog, {
                  title: t("Restart kernel?", "重启内核？"),
                  message: t(
                    "All variables in this kernel will be lost. Saved files and conversation history are retained.",
                    "此内核中的变量将丢失，已保存文件和会话记录会保留。",
                  ),
                  confirmLabel: t("Restart", "重启"),
                  danger: true,
                })
                if (!confirmed || !current()) return
                await json(
                  await sdk.request(`/notebook/kernels/${encodeURIComponent(kernelID)}/restart`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ sessionID }),
                  }),
                )
              })
            }
          />
        )
      }}
    </Show>
  )
}
