import { Button } from "@synsci/ui/button"
import { For, Show, type JSX } from "solid-js"
import type { TimelineViewProps } from "./TimelineView"

export function TimelineWorkbenchView(props: TimelineViewProps): JSX.Element {
  const state = () => props.data.workbench
  const ready = () =>
    !!state() && !props.data.error && !props.data.workbenchError && !props.mutation && state()?.status === "idle"
  const connected = () => !!state() && !props.data.error && !props.data.workbenchError && !props.mutation
  const t = props.t
  return (
    <aside class="action-timeline__workbench" aria-label={t("Session workbench", "会话工作台")}>
      <Show when={props.data.workbenchError}>
        <p class="action-timeline__error" role="alert">
          {props.data.workbenchError}
        </p>
      </Show>
      <section class="action-timeline__card">
        <h3>{t("Branch · Checkpoint", "分支 · 检查点")}</h3>
        <div class="action-timeline__buttons">
          <Button size="small" variant="ghost" disabled={!ready()} onClick={props.checkpoint}>
            {t("Save checkpoint", "创建检查点")}
          </Button>
          <Button size="small" variant="ghost" disabled={!ready()} onClick={() => props.fork()}>
            {t("Fork session", "创建会话分支")}
          </Button>
        </div>
        <p>
          {t(
            "Save the conversation boundary and a verified execution recipe. Recovery creates a separate branch and preserves the source kernel.",
            "保存会话边界与执行恢复计划。恢复在独立分支进行，保留原内核。",
          )}
        </p>
        <Show when={state()?.revert}>
          <Button size="small" variant="ghost" disabled={!ready()} onClick={props.restore}>
            {t("Restore undone conversation", "恢复已撤销的会话")}
          </Button>
        </Show>
        <For each={state()?.checkpoints}>
          {(checkpoint) => (
            <div class="action-timeline__item">
              <Button size="small" variant="ghost" onClick={() => props.openCheckpoint(checkpoint.path)}>
                {new Date(checkpoint.createdAt).toLocaleString()}
              </Button>
              <small>{checkpoint.summary}</small>
              <div class="action-timeline__buttons">
                <Button
                  size="small"
                  variant="ghost"
                  disabled={!connected()}
                  onClick={() => props.previewRecovery?.(checkpoint.id)}
                >
                  {t("Recovery plan", "恢复计划")}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={!ready()}
                  onClick={() => props.forkCheckpoint?.(checkpoint.id)}
                >
                  {t("Fork here", "从此处分支")}
                </Button>
              </div>
            </div>
          )}
        </For>
        <Show when={state() && !state()?.checkpoints.length}>
          <small>{t("No saved checkpoints.", "尚无保存的检查点。")}</small>
        </Show>
        <Show when={state()?.branches?.length}>
          <details>
            <summary>{t("Branch lineage", "分支谱系")}</summary>
            <For each={state()?.branches}>
              {(branch) => (
                <div class="action-timeline__item">
                  <Button size="small" variant="ghost" onClick={() => props.openSession(branch.sourceID)}>
                    {branch.sourceID.slice(-10)}
                  </Button>
                  <span aria-hidden="true">↓</span>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={branch.sessionID === props.sessionID}
                    onClick={() => props.openSession(branch.sessionID)}
                  >
                    {branch.sessionID.slice(-10)}
                  </Button>
                </div>
              )}
            </For>
          </details>
        </Show>
      </section>
      <Show when={props.recoveryPlan}>
        {(plan) => (
          <section class="action-timeline__card" aria-label={t("Recovery plan", "恢复计划")}>
            <h3>{t("Recovery preview", "恢复预览")}</h3>
            <p>
              {plan().safe} {t("safe steps", "个可重放步骤")} · {plan().manual} {t("manual steps", "个人工步骤")}
            </p>
            <small>
              {t(
                "Verified literal state is replayed in a new branch. Imports, dependencies and external effects require manual review. Files are not rolled back.",
                "在新分支重放已验证的字面量状态。导入、依赖和外部副作用需人工处理；文件不会回退。",
              )}
            </small>
            <details>
              <summary>{t("Inspect every step", "查看所有步骤")}</summary>
              <For each={plan().steps}>
                {(step) => (
                  <div class="action-timeline__item">
                    <strong>
                      {step.language} · {step.policy}
                    </strong>
                    <small>
                      {step.id} · {t("Generation", "代次")} {step.generation ?? "—"}
                    </small>
                    <small>{step.reason}</small>
                    <code title={step.hash}>{step.hash.slice(0, 16)}</code>
                  </div>
                )}
              </For>
            </details>
            <Button
              size="small"
              variant="ghost"
              disabled={!ready() || state()?.recoveries?.some((run) => run.status === "running")}
              onClick={() => props.recover?.(plan().checkpointID)}
            >
              {t("Recover to new branch", "恢复到新分支")}
            </Button>
          </section>
        )}
      </Show>
      <Show when={state()?.recoveries?.length}>
        <section class="action-timeline__card">
          <h3>{t("Recovery log", "恢复日志")}</h3>
          <For each={state()?.recoveries}>
            {(run) => (
              <div class="action-timeline__item">
                <strong>
                  {run.status} · {run.completed}/{run.total}
                </strong>
                <small>
                  {new Date(run.updatedAt).toLocaleString()} · {run.manual} {t("manual steps", "个人工步骤")}
                </small>
                <Show when={run.error}>
                  <p role="alert">{run.error}</p>
                </Show>
                <div class="action-timeline__buttons">
                  <Show when={run.targetID && run.status !== "running"}>
                    <Button size="small" variant="ghost" onClick={() => props.openSession(run.targetID!)}>
                      {t("Open recovery branch", "打开恢复分支")}
                    </Button>
                  </Show>
                  <Show when={["failed", "interrupted", "partial"].includes(run.status)}>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!connected()}
                      onClick={() => props.previewRecovery?.(run.checkpointID)}
                    >
                      {t("Review / retry", "检查 / 重试")}
                    </Button>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </section>
      </Show>
      <Show when={state()?.runs?.length}>
        <section class="action-timeline__card">
          <h3>{t("Execution queue", "执行队列")}</h3>
          <For each={state()?.runs}>
            {(run) => (
              <div class="action-timeline__item">
                <strong>{run.status}</strong>
                <small>{run.id}</small>
                <Button size="small" variant="ghost" disabled={!connected()} onClick={() => props.cancelRun?.(run.id)}>
                  {t("Cancel this run", "取消本次执行")}
                </Button>
              </div>
            )}
          </For>
        </section>
      </Show>
      <section class="action-timeline__card">
        <h3>{t("Kernel runtime", "内核运行状态")}</h3>
        <For each={state()?.kernels}>
          {(kernel) => (
            <div class="action-timeline__item">
              <strong>
                {kernel.language.toUpperCase()} · {kernel.state}
              </strong>
              <small>
                {t("Generation", "代次")} {kernel.incarnation ?? "—"} · {t("Queue", "排队")} {kernel.queued}
              </small>
              <Button
                size="small"
                variant="ghost"
                disabled={!ready() || kernel.state === "running" || kernel.queued > 0}
                onClick={() => props.restart(kernel.id)}
              >
                {t("Fresh restart", "全新重启")}
              </Button>
            </div>
          )}
        </For>
        <Show when={state() && !state()?.kernels.length}>
          <p>{t("No kernels in this session.", "此会话尚无内核。")}</p>
        </Show>
        <Show when={state()?.executions?.length}>
          <details>
            <summary>{t("Durable execution history (latest 200)", "持久化执行历史（最近 200 条）")}</summary>
            <For each={state()?.executions}>
              {(execution) => (
                <div class="action-timeline__item">
                  <strong>
                    {execution.language} · {execution.status}
                  </strong>
                  <small>
                    {execution.id} · {t("Generation", "代次")} {execution.generation ?? "—"}
                  </small>
                  <dl>
                    <dt>{t("Queued", "入队")}</dt>
                    <dd>{execution.queuedAt ?? "—"}</dd>
                    <dt>{t("Started", "开始")}</dt>
                    <dd>{execution.startedAt ?? "—"}</dd>
                    <dt>{t("Finished", "结束")}</dt>
                    <dd>{execution.completedAt ?? "—"}</dd>
                  </dl>
                </div>
              )}
            </For>
          </details>
        </Show>
      </section>
      <section class="action-timeline__card">
        <h3>{t("Child agents", "子代理")}</h3>
        <For each={state()?.children}>
          {(child) => (
            <div class="action-timeline__item">
              <strong>
                {child.agent} · {child.status}
              </strong>
              <small>
                {child.toolCalls ?? "—"} {t("tool calls", "次工具调用")}
              </small>
              <Show when={child.sessionID}>
                {(id) => (
                  <div class="action-timeline__buttons">
                    <Button size="small" variant="ghost" onClick={() => props.openSession(id())}>
                      {t("Open session", "打开会话")}
                    </Button>
                    <Show when={["running", "pending"].includes(child.status)}>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={!connected()}
                        onClick={() => props.childControl?.(id(), "steer")}
                      >
                        {t("Guide", "引导")}
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={!connected()}
                        onClick={() => props.childControl?.(id(), "stop")}
                      >
                        {t("Stop", "停止")}
                      </Button>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          )}
        </For>
        <Show when={state() && !state()?.children.length}>
          <p>{t("No child agents.", "此会话尚未创建子代理。")}</p>
        </Show>
      </section>
      <section class="action-timeline__card">
        <h3>{t("Compute jobs", "计算任务")}</h3>
        <For each={state()?.jobs}>
          {(job) => (
            <div class="action-timeline__item">
              <strong>{job.name}</strong>
              <small>
                {job.target} · {job.status} · {job.artifactCount} {t("artifacts", "个制品")}
              </small>
              <Show
                when={["pending", "queued", "running", "submitted", "staging", "provisioning"].includes(job.status)}
              >
                <Button size="small" variant="ghost" disabled={!connected()} onClick={() => props.cancelJob?.(job.id)}>
                  {t("Cancel job", "取消任务")}
                </Button>
              </Show>
            </div>
          )}
        </For>
        <Show when={state() && !state()?.jobs.length}>
          <p>{t("No compute jobs.", "此会话尚无计算任务。")}</p>
        </Show>
      </section>
      <section class="action-timeline__card">
        <h3>{t("Context usage", "上下文用量")}</h3>
        <small>
          {t(
            "Latest provider-reported usage; reasoning is included in output.",
            "最近一次提供商报告的用量；推理已包含在输出中。",
          )}
        </small>
        <Show when={state()?.composition}>
          {(composition) => (
            <details>
              <summary>{t("Last request composition (estimated)", "最近请求组成（估算）")}</summary>
              <small>
                {new Date(composition().recordedAt).toLocaleString()} · {composition().total} / {composition().usable}
              </small>
              <meter
                min="0"
                max={Math.max(1, composition().usable)}
                value={composition().total}
                aria-label={t("Estimated context budget usage", "估算上下文预算用量")}
              />
              <dl>
                <For each={["system", "text", "reasoning", "tool", "skills", "image", "document"] as const}>
                  {(key) => (
                    <>
                      <dt>{key}</dt>
                      <dd>{composition()[key]}</dd>
                    </>
                  )}
                </For>
              </dl>
            </details>
          )}
        </Show>
        <dl>
          <dt>Input</dt>
          <dd>{state()?.context.input ?? "—"}</dd>
          <dt>Output</dt>
          <dd>{state()?.context.output ?? "—"}</dd>
          <dt>Reasoning</dt>
          <dd>{state()?.context.reasoning ?? "—"}</dd>
          <dt>Cache read</dt>
          <dd>{state()?.context.cacheRead ?? "—"}</dd>
          <dt>Cache write</dt>
          <dd>{state()?.context.cacheWrite ?? "—"}</dd>
          <dt>{t("Compactions", "压缩次数")}</dt>
          <dd>{state()?.context.compactions ?? "—"}</dd>
        </dl>
      </section>
      <section class="action-timeline__card">
        <h3>{t("Sandbox · Permissions", "沙箱 · 权限")}</h3>
        <For each={state()?.kernels}>
          {(kernel) => (
            <p>
              {kernel.language.toUpperCase()} · {kernel.sandbox} ·{" "}
              {kernel.enforced === null
                ? t("unknown", "未知")
                : kernel.enforced
                  ? t("enforced", "已强制隔离")
                  : t("not enforced", "未强制隔离")}{" "}
              · {t("network", "网络")} {kernel.network}
            </p>
          )}
        </For>
        <p>
          {t("Pending approvals", "待处理授权")} {state()?.permissions.pending ?? "—"}
        </p>
        <p>
          {t("Rejected", "已拒绝")} {state()?.permissions.rejected ?? "—"} / {state()?.permissions.total ?? "—"}
        </p>
      </section>
    </aside>
  )
}
