import { randomUUID } from "node:crypto"
import z from "zod"
import { Project } from "../project/project"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { MemorySchema } from "./schema"
import { memoryRepository, MemoryError } from "./repository"
import { memoryKey, recallMemory, sameScope } from "./recall"

const log = Log.create({ service: "memory" })
const SessionMetadata = z.object({
  id: MemorySchema.ID,
  projectID: MemorySchema.ID,
  title: z.string(),
  parentID: MemorySchema.ID.optional(),
  time: z.object({ updated: z.number(), archived: z.number().optional() }),
})

async function session(projectID: string, sessionID: string) {
  const data = SessionMetadata.parse(await Storage.read<unknown>(["session", projectID, sessionID]))
  if (data.projectID !== projectID || data.id !== sessionID)
    throw new MemoryError("This session does not belong to the selected project", 404)
  return data
}

async function validate(target: MemorySchema.Target) {
  MemorySchema.Target.parse(target)
  if (target.projectID) await Project.get(target.projectID)
  if (target.projectID && target.sessionID) await session(target.projectID, target.sessionID)
}

async function ancestry(target: MemorySchema.Target) {
  if (!target.projectID || !target.sessionID) return []
  const ancestors: string[] = []
  const visited = new Set([target.sessionID])
  let current = await session(target.projectID, target.sessionID)
  // 子任务继承所属会话的偏好；只沿本项目父链查找，防止跨项目或循环引用泄漏。
  while (current.parentID && ancestors.length < 32 && !visited.has(current.parentID)) {
    const parent = await session(target.projectID, current.parentID).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (!parent) break
    visited.add(parent.id)
    ancestors.unshift(parent.id)
    current = parent
  }
  return ancestors
}

export function createMemoryService(repository = memoryRepository()) {
  const read = repository.read
  const preview = async (target: MemorySchema.Target) => {
    await validate(target)
    const [store, ancestors] = await Promise.all([read(), ancestry(target)])
    return recallMemory(store, target, ancestors)
  }
  return {
    read,
    preview,
    async catalog(projectID?: string) {
      if (projectID) await validate({ projectID })
      const projects = (await Project.list()).map((project) => ({
        id: project.id,
        name: project.name || project.worktree,
        archived: !!project.time.archived,
      }))
      const sessions: z.infer<typeof SessionMetadata>[] = []
      const keys = projectID ? await Storage.list(["session", projectID]) : []
      for (let offset = 0; offset < keys.length; offset += 32) {
        const batch = await Promise.all(
          keys.slice(offset, offset + 32).map(async (key) => {
            const raw = await Storage.read<unknown>(key).catch((error) => {
              if (error instanceof Storage.NotFoundError) return undefined
              throw error
            })
            const result = SessionMetadata.safeParse(raw)
            return result.success && result.data.projectID === projectID ? result.data : undefined
          }),
        )
        sessions.push(...batch.filter((x): x is z.infer<typeof SessionMetadata> => !!x))
      }
      return {
        projects: projects.sort((a, b) => a.name.localeCompare(b.name)),
        sessions: sessions
          .sort((a, b) => b.time.updated - a.time.updated)
          .map((x) => ({
            id: x.id,
            title: x.title,
            parentID: x.parentID,
            archived: !!x.time.archived,
          })),
      }
    },
    setEnabled: (revision: number, enabled: boolean) =>
      repository.update(revision, (store) => {
        store.enabled = enabled
      }),
    async saveNote(revision: number, value: z.input<typeof MemorySchema.NoteInput>, id?: string) {
      const input = MemorySchema.NoteInput.parse(value)
      await validate(
        input.scope.kind === "global"
          ? {}
          : input.scope.kind === "project"
            ? { projectID: input.scope.projectID }
            : { projectID: input.scope.projectID, sessionID: input.scope.sessionID },
      )
      return repository.update(revision, (store) => {
        if (!store.categories.some((x) => x.id === input.categoryID))
          throw new MemoryError("Choose an existing category")
        const existing = id ? store.notes.find((x) => x.id === id) : undefined
        if (id && !existing) throw new MemoryError("This memory no longer exists", 404)
        if (!existing && store.notes.length >= MemorySchema.limits.notes)
          throw new MemoryError("Memory is full. Remove unused notes before adding more.")
        if (
          store.notes.some(
            (x) =>
              x.id !== id &&
              x.categoryID === input.categoryID &&
              sameScope(x.scope, input.scope) &&
              memoryKey(x.title) === memoryKey(input.title),
          )
        ) {
          throw new MemoryError(
            "A memory with this title already exists in this category and scope. Edit it or choose a different title.",
            409,
          )
        }
        const note = {
          ...input,
          id: existing?.id ?? randomUUID(),
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        }
        if (existing) store.notes[store.notes.indexOf(existing)] = note
        else store.notes.push(note)
      })
    },
    removeNotes: (revision: number, ids: string[]) =>
      repository.update(revision, (store) => {
        if (ids.some((id) => !store.notes.some((x) => x.id === id)))
          throw new MemoryError("A selected memory no longer exists. Refresh and try again.", 409)
        const selected = new Set(ids)
        store.notes = store.notes.filter((x) => !selected.has(x.id))
      }),
    saveCategory: (revision: number, value: z.input<typeof MemorySchema.CategoryInput>, id?: string) =>
      repository.update(revision, (store) => {
        const input = MemorySchema.CategoryInput.parse(value)
        const existing = id ? store.categories.find((x) => x.id === id) : undefined
        if (id && !existing) throw new MemoryError("This category no longer exists", 404)
        if (!existing && store.categories.length >= MemorySchema.limits.categories)
          throw new MemoryError("The category limit has been reached")
        if (store.categories.some((x) => x.id !== id && memoryKey(x.name) === memoryKey(input.name)))
          throw new MemoryError("A category with this name already exists", 409)
        const category = { ...input, id: existing?.id ?? randomUUID() }
        if (existing) store.categories[store.categories.indexOf(existing)] = category
        else store.categories.push(category)
      }),
    removeCategory: (revision: number, id: string) =>
      repository.update(revision, (store) => {
        if (id === "about-you") throw new MemoryError("The About you category cannot be deleted")
        if (!store.categories.some((x) => x.id === id)) throw new MemoryError("This category no longer exists", 404)
        if (store.notes.some((x) => x.categoryID === id))
          throw new MemoryError("Move or delete the notes in this category first")
        store.categories = store.categories.filter((x) => x.id !== id)
      }),
    async system(projectID: string, sessionID: string) {
      // 记忆损坏不应阻塞研究任务；设置页仍返回明确错误，并保留原文件供恢复。
      return preview({ projectID, sessionID })
        .then((result) => (result.system ? [result.system] : []))
        .catch((error) => {
          log.error("could not recall saved memory", { error: error instanceof Error ? error.message : String(error) })
          return [] as string[]
        })
    },
  }
}

export const Memory = createMemoryService()
