import type { MemoryCatalog } from "@synsci/sdk/v2"
import type { useWorkspaces } from "@/workspaces/context"

export type MemoryWorkspaces = Pick<
  ReturnType<typeof useWorkspaces>,
  "state" | "localUrl" | "remoteBase" | "connect" | "refresh"
>

export function memoryProjects(catalog: MemoryCatalog, workspaces?: MemoryWorkspaces) {
  if (!workspaces)
    return catalog.projects.map((project) => ({
      value: project.id,
      projectID: project.id,
      name: project.name,
      remoteID: "",
      detail: project.archived ? "archived" : "",
    }))
  // 侧栏目录才代表用户加入工作台的项目；后端历史记录还包含内部目录和已归档项目。
  return [
    ...workspaces.state.projects
      .filter((project) => !project.time.archived)
      .map((project) => ({
        value: project.id,
        projectID: project.id,
        name: project.name || project.worktree,
        remoteID: "",
        detail: "Local",
      })),
    ...workspaces.state.remotes.map((remote) => ({
      value: `remote:${remote.id}`,
      projectID: remote.projectID ?? "",
      name: remote.name,
      remoteID: remote.id,
      detail: `${remote.target.kind.toUpperCase()} · ${remote.state}`,
    })),
  ]
}
