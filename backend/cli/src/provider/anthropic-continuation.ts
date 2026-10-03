const MAX_ERROR_BYTES = 16_384

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function expired(response: Response) {
  if (Number(response.headers.get("content-length")) > MAX_ERROR_BYTES) return false
  const reader = response.clone().body?.getReader()
  if (!reader) return false
  const decoder = new TextDecoder()
  let text = ""
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_ERROR_BYTES) return false
      text += decoder.decode(chunk.value, { stream: true })
    }
    const body = parse(text + decoder.decode())
    if (!object(body) || !object(body.error)) return false
    return (
      body.error.type === "invalid_request_error" &&
      body.error.message === "synthetic previous_response_id is unavailable or expired"
    )
  } catch {
    return false
  } finally {
    // tee 的取消可能等待原响应被消费；这里只关闭检查分支，保留原始错误供 SDK 展示。
    void reader.cancel().catch(() => undefined)
  }
}

function replay(body: string) {
  const value = parse(body)
  if (!object(value) || !Array.isArray(value.messages)) return
  const ids = new Map<string, string>()
  for (const message of value.messages) {
    if (!object(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!object(part) || part.type !== "tool_use" || typeof part.id !== "string") continue
      if (!ids.has(part.id)) ids.set(part.id, `call_${crypto.randomUUID().replaceAll("-", "")}`)
    }
  }

  let changed = false
  const messages = value.messages.flatMap((message: unknown) => {
    if (!object(message) || !Array.isArray(message.content)) return [message]
    const content = message.content.flatMap((part: unknown) => {
      if (!object(part)) return [part]
      // 兼容网关可能把签名和工具 ID 绑定到临时 Responses 状态。恢复或显式兼容模式重建时，
      // 保留工具名称、参数和已完成的结果，避免重新执行已经产生科研产物的操作。
      if (message.role === "assistant" && (part.type === "thinking" || part.type === "redacted_thinking")) {
        changed = true
        return []
      }
      const field = part.type === "tool_use" ? "id" : part.type === "tool_result" ? "tool_use_id" : undefined
      const id = field && typeof part[field] === "string" ? ids.get(part[field]) : undefined
      if (!field || !id) return [part]
      changed = true
      return [{ ...part, [field]: id }]
    })
    return content.length ? [{ ...message, content }] : []
  })
  return changed ? JSON.stringify({ ...value, messages }) : undefined
}

export function normalizeAnthropicContinuation(body: string, mode: unknown): string {
  if (mode !== "stateless") return body
  const value = parse(body)
  if (!object(value) || typeof value.model !== "string" || value.model.toLowerCase().includes("claude")) return body
  // 非 Claude 兼容网关的签名和工具 ID 可能指向已经失效的上游响应；显式启用后每次完整重放，
  // 仅修改发往网关的副本，保留会话中的推理和工具结果，不触发已完成工具的执行。
  return replay(body) ?? body
}

export async function retrySyntheticContinuation(input: {
  response: Response
  enabled: boolean
  body?: string
  signal?: AbortSignal | null
  retry: (body: string) => Promise<Response>
}): Promise<Response> {
  // 只恢复收到 HTTP 400、尚未交给 SDK 的拒绝响应；流中断、普通参数错误及原生接口不重放。
  if (!input.enabled || input.response.status !== 400 || !input.body) return input.response
  input.signal?.throwIfAborted()
  if (!(await expired(input.response))) return input.response
  const body = replay(input.body)
  if (!body) return input.response
  input.signal?.throwIfAborted()
  await input.response.body?.cancel().catch(() => undefined)
  input.signal?.throwIfAborted()
  return input.retry(body)
}
