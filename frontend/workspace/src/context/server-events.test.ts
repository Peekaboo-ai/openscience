import { expect, test } from "bun:test"
import type { GlobalEvent } from "@synsci/sdk/v2/client"
import { createServerEvents } from "./server-events"

test("workspace and active chat share one stream, which survives chat navigation", async () => {
  const sources = new Map<string, { emit: (event: GlobalEvent) => void; signal: AbortSignal }>()
  let connections = 0
  const hub = createServerEvents(async (base, _fetch, signal) => {
    connections++
    const stream = new ReadableStream<GlobalEvent>({
      start(controller) {
        sources.set(base, { emit: (event) => controller.enqueue(event), signal })
        signal.addEventListener("abort", () => controller.close(), { once: true })
      },
    })
    return { stream }
  })
  const workspace: string[] = []
  const chat: string[] = []
  const one = hub.subscribe("local", fetch, (e) => workspace.push(e.payload.type))
  const two = hub.subscribe("local", fetch, (e) => chat.push(e.payload.type))
  const three = hub.subscribe("remote", fetch, () => {})
  try {
    expect(connections).toBe(2)
    const event: GlobalEvent = {
      directory: "/project",
      payload: { type: "session.idle", properties: { sessionID: "ses_one" } },
    }
    sources.get("local")!.emit(event)
    await Bun.sleep(20)
    expect(workspace).toEqual(["session.idle"])
    expect(chat).toEqual(workspace)
    two()
    expect(sources.get("local")!.signal.aborted).toBe(false)
    sources.get("local")!.emit(event)
    await Bun.sleep(20)
    expect(workspace).toHaveLength(2)
    expect(chat).toHaveLength(1)
    one()
    expect(sources.get("local")!.signal.aborted).toBe(true)
    expect(sources.get("remote")!.signal.aborted).toBe(false)
  } finally {
    one()
    two()
    three()
  }
})
