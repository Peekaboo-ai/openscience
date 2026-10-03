import type { Event } from "@synsci/sdk/v2/client"

type BufferedEvent = { directory: string; payload: Event }

export function createGlobalEventBuffer() {
  let queue: Array<BufferedEvent | undefined> = []
  let buffer: Array<BufferedEvent | undefined> = []
  const coalesced = new Map<string, number>()
  const key = (directory: string, payload: Event) => {
    // busy→idle是运行边界；即便落在同一帧，也不能像内容快照一样合并，否则完成通知会漏掉下一轮。
    if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
    if (payload.type === "message.part.updated") {
      const part = payload.properties.part
      return `message.part.updated:${directory}:${part.messageID}:${part.id}`
    }
  }
  return {
    get length() {
      return queue.length
    },
    push(directory: string, payload: Event) {
      const id = key(directory, payload)
      if (id) {
        const previous = coalesced.get(id)
        if (previous !== undefined) queue[previous] = undefined
        coalesced.set(id, queue.length)
      }
      queue.push({ directory, payload })
    },
    flush(emit: (event: BufferedEvent) => void) {
      const events = queue
      queue = buffer
      buffer = events
      queue.length = 0
      coalesced.clear()
      for (const event of events) {
        if (event) emit(event)
      }
      buffer.length = 0
    },
  }
}
