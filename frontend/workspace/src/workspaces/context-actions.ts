import type { SessionContext } from "@/pages/session-sidebar-action"

export function createContextActions(scope: () => string) {
  let current: { action: (context: SessionContext) => void; scope: string } | undefined
  let pending: { context: SessionContext; scope: string } | undefined
  return {
    register(action: (context: SessionContext) => void) {
      const entry = { action, scope: scope() }
      current = entry
      const next = pending
      pending = undefined
      // 页面懒加载完成前的点击只交给原项目，避免切换项目后意外打开旧面板。
      if (next?.scope === entry.scope) action(next.context)
      return () => {
        if (current === entry) current = undefined
      }
    },
    open(context: SessionContext) {
      const key = scope()
      if (current?.scope === key) {
        current.action(context)
        return
      }
      pending = { context, scope: key }
    },
  }
}
