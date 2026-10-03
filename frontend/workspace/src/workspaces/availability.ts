import type { RemoteWorkspace } from "./context"

// 目录轮询失败只说明目录暂时无法刷新，不能推翻仍有效的 SSH 连接或卸载正在使用的会话。
export function remoteWorkspaceBlocked(input: { selected: string; remote?: RemoteWorkspace }) {
  return !!input.selected && input.remote?.state !== "connected"
}
