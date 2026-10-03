import { readTimeout } from "@/utils/read-timeout"
import { requestDeadline } from "@/utils/request-deadline"

export function requestFileMetadata<T>(
  request: (path: string, init?: RequestInit, query?: Record<string, string>) => Promise<Response>,
  path: string,
  options: {
    baseUrl?: string
    query?: Record<string, string>
    signal?: AbortSignal
    parse: (response: Response) => Promise<T>
    timeout?: number
  },
) {
  // 目录与授权快照都必须读完整个响应体；只限制fetch头部仍会让侧栏永远处于加载状态。
  return requestDeadline(
    async (signal) => options.parse(await request(path, { signal }, options.query)),
    options.timeout ?? readTimeout(options.baseUrl ?? "http://localhost", path),
    options.signal,
  )
}
