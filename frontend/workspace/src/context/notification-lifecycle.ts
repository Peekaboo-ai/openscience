import type { Event } from "@synsci/sdk/v2/client"

export function createNotificationLifecycle() {
  const settled = new Map<string, "failed" | "completed">()
  const remember = (key: string, outcome: "failed" | "completed") => {
    settled.delete(key)
    settled.set(key, outcome)
    if (settled.size > 1_000) settled.delete(settled.keys().next().value!)
  }
  return {
    accept(directory: string, event: Event) {
      if (event.type === "session.deleted") {
        settled.delete(JSON.stringify([directory, event.properties.info.id]))
        return false
      }
      if (event.type !== "session.status" && event.type !== "session.error" && event.type !== "session.idle")
        return false
      const sessionID = event.properties.sessionID
      const key = JSON.stringify([directory, sessionID])
      if (event.type === "session.status") {
        if (event.properties.status.type !== "idle") settled.delete(key)
        return false
      }
      if (event.type === "session.error") {
        if (sessionID) remember(key, "failed")
        return true
      }
      // 后端在失败和取消的 finally 中也发 idle；它表示停止运行，不等于成功完成。
      if (settled.has(key)) return false
      remember(key, "completed")
      return true
    },
  }
}
