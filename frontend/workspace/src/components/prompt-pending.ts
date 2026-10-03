type PendingPrompt = { abort: AbortController; cleanup: VoidFunction }

export const pendingPromptKey = (url: string, directory: string, session: string) =>
  JSON.stringify([url, directory, session])

export function createPendingPrompts() {
  const entries = new Map<string, Set<PendingPrompt>>()
  return {
    add(key: string, prompt: PendingPrompt) {
      const group = entries.get(key) ?? new Set<PendingPrompt>()
      entries.set(key, group)
      group.add(prompt)
      return () => {
        group.delete(prompt)
        if (!group.size && entries.get(key) === group) entries.delete(key)
      }
    },
    abort(key: string) {
      const group = entries.get(key)
      if (!group) return
      entries.delete(key)
      // 从最后一次提交开始回滚，让最早请求清理时能判断已无后续消息，恢复空闲状态。
      for (const prompt of [...group].reverse()) {
        prompt.abort.abort()
        prompt.cleanup()
      }
    },
  }
}
