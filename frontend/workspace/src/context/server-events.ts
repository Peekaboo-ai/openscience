import { createOpenScienceClient, type GlobalEvent } from "@synsci/sdk/v2/client"
import { consumeReconnectingStream } from "./reconnecting-event-stream"

type Listener = (event: GlobalEvent) => void
type Connect = (
  base: string,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
) => Promise<{
  stream: AsyncIterable<GlobalEvent>
}>

export function createServerEvents(connect: Connect) {
  const streams = new Map<string, { abort: AbortController; listeners: Set<Listener> }>()
  return {
    subscribe(base: string, fetch: typeof globalThis.fetch, listener: Listener) {
      let entry = streams.get(base)
      if (!entry) {
        entry = { abort: new AbortController(), listeners: new Set() }
        streams.set(base, entry)
        const current = entry
        let yielded = Date.now()
        void consumeReconnectingStream({
          signal: current.abort.signal,
          connect: () => connect(base, fetch, current.abort.signal),
          onEvent: async (event) => {
            for (const notify of current.listeners) {
              try {
                notify(event)
              } catch (error) {
                console.warn("Server event listener failed", error)
              }
            }
            if (Date.now() - yielded < 8) return
            yielded = Date.now()
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
          },
        })
      }
      entry.listeners.add(listener)
      const current = entry
      return () => {
        current.listeners.delete(listener)
        if (current.listeners.size) return
        current.abort.abort()
        if (streams.get(base) === current) streams.delete(base)
      }
    },
  }
}

// 工作台状态与当前对话共享每个后端的一条事件流；切换项目不会漏掉后台任务的完成事件。
export const serverEvents = createServerEvents((baseUrl, fetch, signal) =>
  createOpenScienceClient({ baseUrl, fetch, signal }).global.event(),
)
