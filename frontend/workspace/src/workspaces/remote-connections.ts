import type { RemoteWorkspace } from "./context"

type Action = "connect" | "disconnect"
type Command = { action: Action; done: Promise<void> }

export function createRemoteConnections(options: {
  read: () => RemoteWorkspace[]
  write: (remotes: RemoteWorkspace[]) => void
  request: (id: string, action: Action) => Promise<RemoteWorkspace | void>
  settled: (remote: RemoteWorkspace) => void
}) {
  const commands = new Map<string, Command>()
  const attempts = new Set<string>()
  const errors = new Map<string, string>()
  let revision = 0
  let disposed = false
  const find = (id: string) => options.read().find((remote) => remote.id === id)
  const update = (id: string, patch: Partial<RemoteWorkspace>) =>
    options.write(options.read().map((remote) => (remote.id === id ? { ...remote, ...patch } : remote)))
  function settle(remote: RemoteWorkspace) {
    if (remote.state === "connecting" || !attempts.delete(remote.id)) return
    if (remote.state === "connected" || remote.state === "error") options.settled(remote)
  }
  function run(id: string, action: Action) {
    const remote = find(id)
    if (disposed || !remote) return Promise.resolve()
    const previous = commands.get(id)
    if (previous?.action === action) return previous.done
    if (action === "connect" && (previous || remote.state === "connected" || remote.state === "connecting"))
      return previous?.done ?? Promise.resolve()
    errors.delete(id)
    if (action === "connect") attempts.add(id)
    else attempts.delete(id)
    revision++
    update(id, {
      state: "connecting",
      progress: action === "connect" ? "Preparing connection…" : "Cancelling connection…",
      error: undefined,
    })
    const command: Command = { action, done: Promise.resolve() }
    commands.set(id, command)
    command.done = Promise.resolve()
      .then(async () => {
        // 取消须排在启动请求之后，防止慢启动响应重新激活已取消的连接。
        await previous?.done
        if (disposed || commands.get(id) !== command) return
        const result = await options.request(id, action)
        if (disposed || commands.get(id) !== command) return
        update(id, result ?? { state: "disconnected", progress: "Disconnected", error: undefined })
        const current = find(id)
        if (current) settle(current)
      })
      .catch((error: unknown) => {
        if (disposed || commands.get(id) !== command) return
        const detail = error instanceof Error ? error.message : "Connection request failed"
        errors.set(id, detail)
        update(id, { state: "error", error: detail, progress: "Connection needs attention" })
        attempts.delete(id)
        const current = find(id)
        if (current) options.settled(current)
      })
      .finally(() => {
        if (commands.get(id) !== command) return
        commands.delete(id)
        revision++
      })
    return command.done
  }
  return {
    revision: () => revision,
    connect: (id: string) => run(id, "connect"),
    disconnect: (id: string) => run(id, "disconnect"),
    sync(remotes: RemoteWorkspace[], started: number) {
      // 写操作前发出的目录快照不能回滚即时反馈或重新引入已移除的书签。
      if (disposed || started !== revision) return
      const next = remotes.map((remote) => {
        if (commands.has(remote.id)) return find(remote.id) ?? remote
        if (remote.state !== "disconnected") errors.delete(remote.id)
        const error = errors.get(remote.id)
        return error ? { ...remote, state: "error" as const, error } : remote
      })
      options.write(next)
      for (const remote of next) if (!commands.has(remote.id)) settle(remote)
      for (const id of attempts) if (!next.some((remote) => remote.id === id)) attempts.delete(id)
    },
    forget(id: string) {
      revision++
      commands.delete(id)
      attempts.delete(id)
      errors.delete(id)
    },
    dispose() {
      // 工作区卸载只停止观察；后端连接不属于页面或对话框的生命周期。
      disposed = true
      commands.clear()
      attempts.clear()
      errors.clear()
    },
  }
}
