import z from "zod"
import path from "node:path"
import { Auth } from "../auth"
import { Config } from "../config/config"
import { Global } from "../global"
import { FileLease } from "../util/file-lease"
import { ModelsDev } from "./models"
import { CustomModelLimits } from "./custom-model-limits"

export namespace CustomConnections {
  export const Protocol = z.enum(["openai-chat-completions", "openai-responses", "anthropic-messages"])
  const adapters = {
    "openai-chat-completions": "@ai-sdk/openai-compatible",
    "openai-responses": "@ai-sdk/openai",
    "anthropic-messages": "@ai-sdk/anthropic",
  } as const
  const Thinking = z.enum(["auto", "adaptive"])
  function protocol(provider?: Config.Provider): z.infer<typeof Protocol> {
    if (provider?.npm === "@ai-sdk/anthropic") return "anthropic-messages"
    if (provider?.npm === "@ai-sdk/openai") return "openai-responses"
    return "openai-chat-completions"
  }
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
    protocol: Protocol.optional(),
  })
  export const Input = Endpoint.extend({
    name: z.string().trim().min(1).max(80),
    thinking: Thinking.optional(),
    models: z.array(ModelID).min(1).max(2000),
    context: z.number().int().min(1024).max(2_147_483_647).optional(),
    output: z.number().int().min(1).max(2_147_483_647).optional(),
    limits: z.record(ModelID, CustomModelLimits.Choice).optional(),
  }).refine(
    (input) =>
      (input.context === undefined && input.output === undefined) ||
      (input.context !== undefined && input.output !== undefined && input.output <= input.context),
    {
      message: "Provide both context and output limits; output must not exceed context.",
    },
  )
  export const Selection = z.object({ models: z.array(ModelID).max(2000) })
  export const Limits = z.record(z.string(), CustomModelLimits.Choice)
  export const Connection = z.object({
    id: z.string(),
    name: z.string(),
    baseURL: z.string(),
    protocol: Protocol,
    thinking: Thinking,
    models: z.array(z.string()),
    hasKey: z.boolean(),
    context: z.number(),
    output: z.number(),
    limits: Limits,
  })

  export function normalizeURL(value: string) {
    const url = new URL(value.trim())
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Use an HTTP(S) API base URL without credentials, query parameters, or fragments.")
    }
    url.pathname =
      url.pathname.replace(/\/+$/, "").replace(/\/(models|chat\/completions|responses|messages)$/, "") || "/v1"
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
    const selected = input.protocol ?? protocol(previous)
    if (input.key) return { baseURL, key: input.key, protocol: selected }
    if (!previous || previous.options?.baseURL !== baseURL) {
      throw new Error("Enter an API key for this endpoint. A changed URL requires a new key.")
    }
    const auth = await Auth.get(input.id!)
    if (auth?.type !== "api" || !auth.key.trim()) throw new Error("Enter an API key for this connection.")
    return { baseURL, key: auth.key, protocol: selected }
  }

  export async function list() {
    const config = await Config.getGlobal()
    const catalog = await ModelsDev.get()
    return Promise.all(
      Object.entries(config.provider ?? {})
        .filter(([, p]) => p.options?.customConnection === true)
        .map(async ([id, p]) => {
          const limits = Object.fromEntries(
            Object.entries(p.models ?? {}).map(([id, model]) => [
              id,
              CustomModelLimits.configured(id, model.limit, p.options?.customModelLimits?.[id], catalog),
            ]),
          )
          const first = Object.values(limits)[0]
          const auth = await Auth.get(id)
          return {
            id,
            name: p.name ?? id,
            baseURL: String(p.options?.baseURL ?? p.api ?? ""),
            protocol: protocol(p),
            thinking: p.options?.customThinking === "adaptive" ? ("adaptive" as const) : ("auto" as const),
            models: Object.keys(p.models ?? {}),
            hasKey: auth?.type === "api" && !!auth.key.trim(),
            context: first?.context ?? 128_000,
            output: first?.output ?? 32_000,
            limits,
          }
        }),
    )
  }

  export async function limits(ids: string[]) {
    const catalog = await ModelsDev.get()
    return Object.fromEntries(ids.map((id) => [id, CustomModelLimits.defaults(id, catalog)]))
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
    const { baseURL, key, protocol } = await credentials(input)
    const response = await fetch(`${baseURL}/models`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(protocol === "anthropic-messages" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : {}),
      },
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
    const catalog = await ModelsDev.get()
    const object = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined
    const entries = (Array.isArray(body) ? body : (object?.data ?? object?.models)) as unknown[]
    const metadata = new Map(
      entries.map((entry) => {
        const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined
        const parsed = ModelID.safeParse(typeof entry === "string" ? entry : (value?.id ?? value?.name))
        return [parsed.success ? parsed.data : undefined, entry]
      }),
    )
    return {
      baseURL,
      models,
      limits: Object.fromEntries(models.map((id) => [id, CustomModelLimits.discovered(id, metadata.get(id), catalog)])),
    }
  }

  export async function save(raw: z.input<typeof Input>) {
    const input = Input.parse(raw)
    await using lease = await FileLease.acquire(path.join(Global.Path.data, "custom-model-connections.lock"))
    return await lease.during(async () => {
      const { baseURL, key, protocol } = await credentials(input)
      const id = input.id ?? `custom-${crypto.randomUUID()}`
      const previous = input.id ? await existing(id) : undefined
      const thinking =
        protocol === "anthropic-messages"
          ? (input.thinking ?? (previous?.options?.customThinking === "adaptive" ? "adaptive" : "auto"))
          : "auto"
      const auth = await Auth.get(id)
      const models = [...new Set(input.models)]
      const catalog = await ModelsDev.get()
      const limits = Object.fromEntries(
        models.map((id) => {
          const choice = input.limits?.[id]
          if (choice?.mode === "manual" || choice?.source === "endpoint") return [id, choice]
          if (choice) return [id, CustomModelLimits.defaults(id, catalog)]
          if (input.context !== undefined && input.output !== undefined)
            return [id, { context: input.context, output: input.output, mode: "manual", source: "manual" } as const]
          const keep = previous?.options?.baseURL === baseURL
          return [
            id,
            CustomModelLimits.configured(
              id,
              keep ? previous?.models?.[id]?.limit : undefined,
              keep ? previous?.options?.customModelLimits?.[id] : undefined,
              catalog,
            ),
          ]
        }),
      )
      const block: Config.Provider = {
        name: input.name,
        npm: adapters[protocol],
        api: baseURL,
        options: {
          baseURL,
          customConnection: true,
          customThinking: thinking,
          // 同一网关编辑模型列表时保留已确认的传输兼容设置；换地址不继承旧网关限制。
          ...(previous?.options?.baseURL === baseURL &&
          previous.npm === adapters[protocol] &&
          typeof previous.options.streaming === "boolean"
            ? { streaming: previous.options.streaming }
            : {}),
          ...(protocol === "anthropic-messages" &&
          previous?.npm === adapters[protocol] &&
          previous.options?.baseURL === baseURL &&
          previous.options.anthropicContinuation === "stateless"
            ? { anthropicContinuation: "stateless" }
            : {}),
          customModelLimits: Object.fromEntries(
            models.map((id) => [id, { mode: limits[id].mode, source: limits[id].source }]),
          ),
        },
        whitelist: models,
        models: Object.fromEntries(
          models.map((id) => [
            id,
            {
              id,
              name: id,
              tool_call: true,
              // 显式能力覆盖独立于模型名称，不向其他协议发送 Anthropic 参数。
              ...(thinking === "adaptive" ? { options: { thinking: { type: "adaptive" } } } : {}),
              modalities: { input: ["text"], output: ["text"] },
              limit: {
                context: limits[id].context,
                output: limits[id].output,
                ...(limits[id].input ? { input: limits[id].input } : {}),
              },
            },
          ]),
        ),
      }
      try {
        if (auth?.type !== "api" || auth.key !== key) await Auth.set(id, { type: "api", key })
        await Config.setProvider(id, block, "global", { preserveInstances: true })
      } catch (error) {
        // 配置和凭据分开存储；任一步失败都恢复原连接，避免旧地址使用新密钥。
        if (auth) await Auth.set(id, auth)
        else await Auth.remove(id)
        if (previous) await Config.setProvider(id, previous, "global", { preserveInstances: true })
        else await Config.removeProvider(id, "global", { preserveInstances: true })
        throw error
      }
      const first = limits[models[0]]
      return {
        id,
        name: input.name,
        baseURL,
        protocol,
        thinking,
        models,
        hasKey: true,
        context: first.context,
        output: first.output,
        limits,
      }
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
