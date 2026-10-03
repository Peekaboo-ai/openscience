export function createPromptActivity() {
  const groups = new Map<string, { pending: number; working: boolean }>()
  return {
    add(key: string, working: boolean) {
      const group = groups.get(key) ?? { pending: 0, working }
      groups.set(key, group)
      group.pending++
      let settled = false
      return (accepted: boolean) => {
        if (settled) return false
        settled = true
        group.working ||= accepted
        group.pending--
        if (group.pending) return false
        if (groups.get(key) === group) groups.delete(key)
        // 同组后续提交看到的 busy 可能只是乐观状态；全部失败时恢复最初的空闲状态。
        return !group.working
      }
    },
  }
}
