import z from "zod"
import { Session } from "."
import { Storage } from "@/storage/storage"
import { Instance } from "@/project/instance"
import { SessionStatus } from "./status"
import { SessionPrompt } from "./prompt"
import { ActionTimeline } from "./action-timeline"

export namespace TimelineBranches {
  export const Branch = z
    .object({ sessionID: z.string(), sourceID: z.string(), checkpointID: z.string().optional(), createdAt: z.number() })
    .meta({ ref: "TimelineBranch" })
  export const Preview = z
    .object({ messageID: z.string(), messages: z.number(), actions: z.number(), files: z.string().array() })
    .meta({ ref: "TimelineRevertPreview" })

  export async function list(sessionID: string) {
    await Session.assertDirectory(sessionID)
    const keys = await Storage.list(["timeline_branch", Instance.project.id])
    const records = await Promise.all(keys.map((key) => Storage.read<z.infer<typeof Branch>>(key)))
    const family = new Set([sessionID])
    // 分支关系独立于 parentID：后者属于子代理所有权，混用会导致取消传播错误。
    for (let changed = true; changed;) {
      changed = false
      for (const item of records) {
        if (!family.has(item.sessionID) && !family.has(item.sourceID)) continue
        for (const id of [item.sessionID, item.sourceID])
          if (!family.has(id)) {
            family.add(id)
            changed = true
          }
      }
    }
    const accessible = new Set<string>()
    for await (const session of Session.list()) accessible.add(session.id)
    return records.filter(
      (item) => family.has(item.sessionID) && accessible.has(item.sessionID) && accessible.has(item.sourceID),
    )
  }

  export async function fork(sessionID: string, messageID?: string, checkpointID?: string) {
    await Session.assertDirectory(sessionID)
    if (SessionStatus.get(sessionID).type !== "idle") throw new Session.BusyError(sessionID)
    const source = await Session.get(sessionID)
    const fork = await Session.fork({
      sessionID,
      messageID: messageID ?? (checkpointID ? undefined : source.revert?.messageID),
    })
    await Storage.write(["timeline_branch", Instance.project.id, fork.id], {
      sessionID: fork.id,
      sourceID: sessionID,
      checkpointID,
      createdAt: Date.now(),
    })
    return fork
  }

  export async function preview(sessionID: string, messageID: string) {
    await Session.assertDirectory(sessionID)
    const messages = await Session.messages({ sessionID })
    if (!messages.some((message) => message.info.id === messageID)) throw new Error("Message no longer exists")
    const affected = messages.filter((message) => message.info.id >= messageID)
    return Preview.parse({
      messageID,
      messages: affected.length,
      actions: affected.flatMap((message) => ActionTimeline.project(message, false)).length,
      files: [
        ...new Set(
          affected.flatMap((message) => message.parts.flatMap((part) => (part.type === "patch" ? part.files : []))),
        ),
      ].map((file) => ActionTimeline.text(file)),
    })
  }

  export async function child(sessionID: string, childID: string, operation: "stop" | "steer", text?: string) {
    await Session.assertDirectory(sessionID)
    const child = await Session.get(childID)
    if (child.parentID !== sessionID) throw new Error("The child does not belong to this session")
    const controller = SessionPrompt.activeController(childID)
    if (!controller) throw new Error("The child is no longer running. Open its session to continue it.")
    if (operation === "stop") {
      SessionPrompt.cancel(childID, controller)
      return
    }
    const messages = await Session.messages({ sessionID: childID })
    const latest = messages.findLast((message) => message.info.role === "user")?.info
    if (!latest || latest.role !== "user" || SessionPrompt.activeController(childID) !== controller)
      throw new Error("Child execution changed; refresh before steering")
    // noReply 将引导持久化到现有循环，避免额外启动一次模型执行。
    await SessionPrompt.prompt({
      sessionID: childID,
      agent: latest.agent,
      model: latest.model,
      noReply: true,
      parts: [{ type: "text", text: z.string().trim().min(1).max(16000).parse(text) }],
    })
  }
}
