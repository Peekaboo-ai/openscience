import z from "zod"
import path from "node:path"
import { Auth } from "../auth"
import { Config } from "../config/config"
import { Global } from "../global"
import { FileLease } from "../util/file-lease"

export namespace CustomConnections {
  const ID = z.string().regex(/^custom-[a-f0-9-]{36}$/)
  const ModelID = z
    .string()
    .trim()
    .min(1)
    .max(256)
    .refine((id) => !/[\u0000-\u001f\u007f]/.test(id))
  export const Endpoint = z.object({
    id: ID.optional(),
    url: z.string().trim().min(1).max(2048),
    key: z.string().trim().min(1).max(8192).optional(),
  })
  export const Input = Endpoint.extend({
    name: z.string().trim().min(1).max(80),
    models: z.array(ModelID).min(1).max(2000),
    context: z.number().int().min(1024).max(2097152).default(32768),
    output: z.number().int().min(1).max(262144).default(8192),
  }).refine((input) => input.output <= input.context, { message: "Output limit must not exceed context limit." })
  export const Connection = z.object({
    id: z.string(),
    name: z.string(),
    baseURL: z.string(),
    models: z.array(z.string()),
    hasKey: z.boolean(),
    context: z.number(),
    output: z.number(),
  })

  export function normalizeURL(value: string) {
    const url = new URL(value.trim())
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Use an HTTP(S) API base URL without credentials, query parameters, or fragments.")
    }
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(models|chat\/completions)$/, "") || "/v1"
    return url.toString().replace(/\/+$/, "")
  }

  async function existing(id: string) {
    ID.parse(id)
    const provider = (await Config.getGlobal()).provider?.[id]
    if (provider?.options?.customConnection !== true)
      throw new Error("Custom connection no longer exists. Refresh and try again.")
    return provider
  }

  async function credentials(input: z.infer<typeof Endpoint>) {
    const baseURL = normalizeURL(input.url)
    const previous = input.id ? await existing(input.id) : undefined
    if (input.key) return { baseURL, key: input.key }
    if (!previous || previous.options?.baseURL !== baseURL) {
      throw new Error("Enter an API key for this endpoint. A changed URL requires a new key.")
    }
    const auth = await Auth.get(input.id!)
    if (auth?.type !== "api" || !auth.key.trim()) throw new Error("Enter an API key for this connection.")
    return { baseURL, key: auth.key }
  }

  export async function list() {
    const config = await Config.getGlobal()
    return Promise.all(
      Object.entries(config.provider ?? {})
        .filter(([, p]) => p.options?.customConnection === true)
        .map(async ([id, p]) => {
          const first = Object.values(p.models ?? {})[0]
          const auth = await Auth.get(id)
          return {
            id,
            name: p.name ?? id,
            baseURL: String(p.options?.baseURL ?? p.api ?? ""),
            models: Object.keys(p.models ?? {}),
            hasKey: auth?.type === "api" && !!auth.key.trim(),
            context: first?.limit?.context ?? 32768,
            output: first?.limit?.output ?? 8192,
          }
        }),
    )
  }

  export function parseModels(body: unknown) {
    const object = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined
    const entries = Array.isArray(body) ? body : (object?.data ?? object?.models)
    if (!Array.isArray(entries)) throw new Error("The endpoint did not return a model list. Check the API base URL.")
    const models = entries.flatMap((entry: unknown) => {
      const object = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined
      const result = ModelID.safeParse(typeof entry === "string" ? entry : (object?.id ?? object?.name))
      return result.success ? [result.data] : []
    })
    return [...new Set(models)].sort((a, b) => a.localeCompare(b))
  }

  export async function discover(raw: z.input<typeof Endpoint>) {
    const input = Endpoint.parse(raw)
    const { baseURL, key } = await credentials(input)
    const response = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    }).catch(() => {
      throw new Error(
        "Could not reach the model endpoint within 15 seconds. Check the URL, network, and redirect settings.",
      )
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        response.status === 401 || response.status === 403
          ? "The endpoint rejected this API key. Check the key and its permissions."
          : `Model discovery failed (HTTP ${response.status}). Check that the endpoint supports GET /models.`,
      )
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error("The endpoint returned an empty response.")
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > 2 * 1024 * 1024) throw new Error("The model list exceeds the 2 MB limit.")
        chunks.push(chunk.value)
      }
    } catch {
      await reader.cancel().catch(() => undefined)
      throw new Error("The model list was too large or could not be read within 15 seconds.")
    } finally {
      reader.releaseLock()
    }
    const body: unknown = await new Response(Buffer.concat(chunks)).json().catch(() => {
      throw new Error("The endpoint did not return valid JSON. Check the API base URL.")
    })
    const models = parseModels(body)
    if (models.length > 2000)
      throw new Error("The endpoint returned more than 2,000 models. Add the required model IDs manually.")
    return { baseURL, models }
  }

  export async function save(raw: z.input<typeof Input>) {
    const input = Input.parse(raw)
    await using lease = await FileLease.acquire(path.join(Global.Path.data, "custom-model-connections.lock"))
    return await lease.during(async () => {
      const { baseURL, key } = await credentials(input)
      const id = input.id ?? `custom-${crypto.randomUUID()}`
      const previous = input.id ? await existing(id) : undefined
      const auth = await Auth.get(id)
      const models = [...new Set(input.models)]
      const block: Config.Provider = {
        name: input.name,
        npm: "@ai-sdk/openai-compatible",
        api: baseURL,
        options: { baseURL, customConnection: true },
        whitelist: models,
        models: Object.fromEntries(
          models.map((id) => [
            id,
            {
              id,
              name: id,
              tool_call: true,
              modalities: { input: ["text"], output: ["text"] },
              limit: { context: input.context, output: input.output },
            },
          ]),
        ),
      }
      try {
        await Auth.set(id, { type: "api", key })
        await Config.setProvider(id, block, "global", { preserveInstances: true })
      } catch (error) {
        // 配置和凭据分开存储；任一步失败都恢复原连接，避免旧地址使用新密钥。
        if (auth) await Auth.set(id, auth)
        else await Auth.remove(id)
        if (previous) await Config.setProvider(id, previous, "global", { preserveInstances: true })
        else await Config.removeProvider(id, "global", { preserveInstances: true })
        throw error
      }
      return { id, baseURL, models }
    })
  }

  export async function remove(id: string) {
    await using lease = await FileLease.acquire(path.join(Global.Path.data, "custom-model-connections.lock"))
    return await lease.during(async () => {
      const previous = await existing(id)
      const auth = await Auth.get(id)
      try {
        await Auth.remove(id)
        await Config.removeProvider(id, "global", { preserveInstances: true })
      } catch (error) {
        if (auth) await Auth.set(id, auth)
        await Config.setProvider(id, previous, "global", { preserveInstances: true })
        throw error
      }
      return { removed: true }
    })
  }
}
