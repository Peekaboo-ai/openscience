import path from "node:path"
import { Marked } from "marked"
import z from "zod"
import { localFilePath } from "@synsci/util/path"
import { File } from "@/file"
import { ArtifactFile } from "@/file/artifacts"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Lock } from "@/util/lock"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { ArtifactStore } from "./store"

export namespace ArtifactPublication {
  export const MAX_FILES = 64
  const MAX_BYTES = 64 * 1024 * 1024
  const TOTAL_BYTES = 256 * 1024 * 1024
  const markdown = new Marked()

  export const Event = {
    Published: BusEvent.define(
      "artifact.published",
      z.object({
        projectID: z.string(),
        sessionID: z.string(),
        messageID: z.string(),
      }),
    ),
  }

  export const Report = z.object({
    artifacts: ArtifactStore.Artifact.array(),
    failures: z.object({ path: z.string(), message: z.string() }).array(),
    published: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  export type Report = z.infer<typeof Report>

  export function filePath(href: string): string | undefined {
    const value = href.trim()
    if (!value || /^(?:https?:|mailto:|tel:|data:|blob:|\/\/|#)/i.test(value)) return
    if (/^\/file\/raw\?/.test(value))
      return new URL(value, "http://artifact.invalid").searchParams.get("path") || undefined
    if (/^(?:file|sandbox):/i.test(value)) return localFilePath(value)?.replace(/^\/([A-Za-z]:[\\/])/, "$1")
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) return
    try {
      const target = decodeURIComponent(value.replace(/[?#].*$/, ""))
      return target && !target.includes("\0") ? target : undefined
    } catch {
      return
    }
  }

  // 只登记最终回复明确交付的文件；Markdown 解析器会跳过代码示例中的伪链接和网页引用。
  export function paths(text: string): string[] {
    const files = new Set<string>()
    markdown.walkTokens(markdown.lexer(text), (token) => {
      if (token.type !== "link" && token.type !== "image") return
      const file = filePath(token.href)
      if (file && path.extname(file) && !file.endsWith("/")) files.add(file.replaceAll("\\", "/"))
    })
    return [...files]
  }

  export function completed(
    message: MessageV2.WithParts,
  ): message is MessageV2.WithParts & { info: MessageV2.Assistant } {
    return (
      message.info.role === "assistant" &&
      !!message.info.time.completed &&
      !message.info.error &&
      !message.info.summary &&
      (message.info.finish === "stop" || message.info.finish === "unknown")
    )
  }

  export async function publish(input: {
    sessionID: string
    messageID: string
    messageIDs?: string[]
  }): Promise<Report> {
    await Session.assertDirectory(input.sessionID)
    using _ = await Lock.write(`artifact-publication:${Instance.project.id}:${input.sessionID}:${input.messageID}`)
    const message = await MessageV2.get({ sessionID: input.sessionID, messageID: input.messageID })
    const ids = [...new Set([input.messageID, ...(input.messageIDs ?? [])])]
    const listed = () =>
      ArtifactStore.listResults(Instance.project.id, "active", { sessionID: input.sessionID, messageIDs: ids })
    if (!completed(message)) return { artifacts: await listed(), failures: [], published: 0, truncated: false }
    const candidates = paths(
      message.parts
        .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n"),
    )
    const saved = await listed()
    if (!candidates.length) return { artifacts: saved, failures: [], published: 0, truncated: false }
    const prior = new Map(saved.map((item) => [item.current.sourcePath, item]))
    const trash = new Set(
      (await ArtifactStore.list(Instance.project.id, "trash")).map((item) => item.current.sourcePath),
    )
    const state = { bytes: 0, published: 0, failures: [] as Report["failures"] }
    for (const source of candidates.slice(0, MAX_FILES)) {
      if (prior.has(source) || trash.has(source)) continue
      try {
        const file = await File.rawSource(source, { sessionID: input.sessionID, maxBytes: MAX_BYTES })
        try {
          if (file.size + state.bytes > TOTAL_BYTES)
            throw new Error("Automatic saving reached its size limit. Save this file to Results individually.")
          state.bytes += file.size
          const filename = path.basename(source)
          const artifact = await ArtifactStore.save({
            projectID: Instance.project.id,
            sessionID: input.sessionID,
            messageID: input.messageID,
            sourcePath: source,
            filename,
            kind: ArtifactFile.classify(filename)?.kind ?? "file",
            mimeType: file.mimeType,
            content: file,
            captureQuality: "declared",
            deduplicate: true,
          })
          if (artifact.state === "active") state.published += 1
        } finally {
          await file.close()
        }
      } catch (error) {
        state.failures.push({ path: source, message: error instanceof Error ? error.message : String(error) })
      }
    }
    const artifacts = await listed()
    if (state.published)
      await Bus.publish(Event.Published, {
        projectID: Instance.project.id,
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
    return { artifacts, failures: state.failures, published: state.published, truncated: candidates.length > MAX_FILES }
  }
}
