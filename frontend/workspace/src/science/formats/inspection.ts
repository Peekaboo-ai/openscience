import { createResource, onCleanup, type Accessor } from "solid-js"
import { requestDeadline } from "@/utils/request-deadline"
import { normalizeInspection } from "./binary"

export interface InspectionSource {
  scope: string
  path: string
  sessionID?: string
}

export function createBinaryInspection(
  request: (path: string, init?: RequestInit, query?: Record<string, string | undefined>) => Promise<Response>,
  source: Accessor<InspectionSource>,
  timeout = 60_000,
) {
  let controller: AbortController | undefined
  const resource = createResource(source, async ({ path, sessionID }) => {
    // 同一路径可存在于不同远端；归属变化时取消旧检查，避免过期数据与昂贵的读取继续驻留。
    controller?.abort(new DOMException("Inspection changed", "AbortError"))
    const current = new AbortController()
    controller = current
    return requestDeadline(
      async (signal) => {
        const response = await request("/file/inspect", { signal }, { path, sessionID })
        if (!response.ok) throw new Error(`Inspection failed (${response.status})`)
        return normalizeInspection(await response.json())
      },
      timeout,
      current.signal,
    )
  })
  onCleanup(() => controller?.abort(new DOMException("Inspection closed", "AbortError")))
  return resource
}
