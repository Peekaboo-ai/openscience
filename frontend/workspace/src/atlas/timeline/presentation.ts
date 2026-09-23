import type { Entry } from "./model"
import type { IconProps } from "@synsci/ui/icon"

export type Translate = (en: string, zh: string) => string
export type Catalog = ReadonlyArray<{
  id: string
  name: string
  models: Record<string, { name: string }>
}>
type Label = readonly [string, string]
type Action = readonly [string, string, IconProps["name"]]

const kinds: Record<Entry["kind"], Action> = {
  user: ["Submit request", "提出研究请求", "comment"],
  inference: ["Model response", "模型分析与响应", "brain"],
  tool: ["Use tool", "调用工具", "settings-gear"],
  kernel: ["Run analysis", "运行计算分析", "flask"],
  delegation: ["Delegate research", "委派研究任务", "branch"],
  retry: ["Retry request", "重试模型请求", "refresh"],
  compaction: ["Compact context", "压缩对话上下文", "collapse"],
  checkpoint: ["Record file snapshot", "记录文件快照", "copy"],
}

const tools: Record<string, Action> = {
  skill: ["Load research skill", "加载研究技能", "book-open"],
  read: ["Read file", "读取文件", "file"],
  write: ["Write file", "写入文件", "edit"],
  edit: ["Edit file", "编辑文件", "edit"],
  apply_patch: ["Apply file changes", "应用文件修改", "edit"],
  bash: ["Run terminal command", "运行终端命令", "console"],
  glob: ["Find files", "查找文件", "folder"],
  grep: ["Search file contents", "搜索文件内容", "magnifying-glass"],
  ls: ["Browse directory", "浏览目录", "folder"],
  python: ["Run Python analysis", "运行 Python 分析", "flask"],
  notebook: ["Run Python analysis", "运行 Python 分析", "flask"],
  r: ["Run R analysis", "运行 R 分析", "flask"],
  rkernel: ["Run R analysis", "运行 R 分析", "flask"],
  research_search: ["Search research sources", "检索研究资料", "magnifying-glass"],
  literature: ["Review scientific literature", "检索科研文献", "book-open"],
  websearch: ["Search the web", "搜索网络资料", "magnifying-glass"],
  webfetch: ["Read web page", "读取网页", "link"],
  codesearch: ["Search code references", "检索代码参考", "code"],
  task: kinds.delegation,
  todowrite: ["Update task plan", "更新任务计划", "checklist"],
  todoread: ["Review task plan", "查看任务计划", "checklist"],
  plan: ["Plan research", "制定研究计划", "checklist"],
  plan_enter: ["Enter planning mode", "进入规划模式", "checklist"],
  plan_exit: ["Finish planning", "完成研究规划", "checklist"],
  question: ["Request clarification", "请求用户补充信息", "comment"],
  recall: ["Recall prior research", "检索研究记忆", "magnifying-glass"],
  artifact: ["Manage research artifacts", "管理研究成果", "file"],
  study: ["Manage research study", "管理研究课题", "flask"],
  experiments: ["Manage experiments", "管理实验", "flask"],
  compute_job: ["Manage compute job", "管理计算任务", "server"],
  generate_image: ["Generate image", "生成图像", "photo"],
  lsp: ["Inspect code structure", "分析代码结构", "code"],
  invalid: ["Validate tool call", "检查工具调用", "alert-circle"],
}

const statuses: Record<string, Label> = {
  pending: ["Pending", "等待执行"],
  running: ["Running", "执行中"],
  completed: ["Completed", "已完成"],
  partial: ["Partially completed", "部分完成"],
  error: ["Failed", "失败"],
  cancelled: ["Cancelled", "已取消"],
  interrupted: ["Interrupted", "已中断"],
  idle: ["Ready", "就绪"],
  busy: ["Working", "正在执行"],
  retry: ["Retrying", "正在重试"],
  compacting: ["Compacting context", "正在压缩上下文"],
  queued: ["Queued", "排队中"],
  accepted: ["Accepted", "已接收"],
  failed: ["Failed", "失败"],
  stopped: ["Stopped", "已停止"],
  starting: ["Starting", "启动中"],
  ready: ["Ready", "就绪"],
  missing: ["Unavailable", "不可用"],
  succeeded: ["Succeeded", "执行成功"],
  submitted: ["Submitted", "已提交"],
  staging: ["Preparing files", "准备文件中"],
  provisioning: ["Allocating resources", "分配资源中"],
  timed_out: ["Timed out", "已超时"],
  timeout: ["Timed out", "已超时"],
  dead: ["Stopped", "已停止"],
  unknown: ["Unknown state", "状态未知"],
}

export function statusLabel(status: string, t: Translate) {
  const label = statuses[status]
  return label ? t(...label) : t("Unknown state", "状态未知")
}

export function requestTitle(entry: Entry | undefined, t: Translate) {
  return entry?.kind === "user" && entry.title.trim() && entry.title !== "User request"
    ? entry.title
    : t("Research request", "研究请求")
}

export function present(entry: Entry, t: Translate, catalog: Catalog = []) {
  const action = (entry.tool && tools[entry.tool]) || kinds[entry.kind]
  const provider = catalog.find((item) => item.id === entry.provider)
  const providerName =
    provider?.name || (entry.provider?.startsWith("custom-") ? t("Custom provider", "自定义供应商") : entry.provider)
  const modelName = (entry.model && provider?.models[entry.model]?.name) || entry.model
  const subtitle =
    entry.kind === "inference"
      ? [modelName, providerName].filter(Boolean).join(" · ") || t("Assistant response", "智能体响应")
      : entry.kind === "user"
        ? t("Starts this request's execution history", "本次请求的执行起点")
        : entry.tool && !tools[entry.tool]
          ? entry.tool
          : t(kinds[entry.kind][0], kinds[entry.kind][1])
  return {
    title: t(action[0], action[1]),
    subtitle,
    icon: action[2],
    status:
      entry.kind === "user" && entry.status === "completed" ? t("Received", "已接收") : statusLabel(entry.status, t),
    model: modelName,
    provider: providerName,
  }
}

export function statusHint(entry: Entry, t: Translate) {
  if (entry.status === "error")
    return entry.kind === "inference"
      ? t(
          "The model request failed. Inspect the original conversation for the provider's error.",
          "本次模型请求失败。请在原对话中查看供应商返回的错误原因。",
        )
      : t(
          "This step failed. Inspect the original conversation for its inputs and result.",
          "此步骤执行失败。请在原对话中查看输入与执行结果。",
        )
  if (entry.status === "interrupted")
    return t(
      "No completion was recorded. Check the result before retrying.",
      "未记录到完成结果。重试前请先确认实际执行情况。",
    )
  if (entry.status === "partial")
    return t(
      "Only part of this step completed. Review its result before continuing.",
      "此步骤仅部分完成，请检查执行结果后再继续。",
    )
  if (entry.status === "cancelled")
    return t(
      "Execution was cancelled. Any existing outputs may still remain.",
      "执行已取消，之前生成的结果可能仍然保留。",
    )
  return ""
}
