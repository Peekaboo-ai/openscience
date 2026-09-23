import { type ParentProps } from "solid-js"
import { WorkspaceShell } from "@/workspaces/Sidebar"

// 项目与普通任务共享同一个导航壳，切换后端时由上层重新挂载数据上下文。
export default function Layout(props: ParentProps) {
  return <WorkspaceShell>{props.children}</WorkspaceShell>
}
