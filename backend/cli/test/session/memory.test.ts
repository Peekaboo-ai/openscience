import { describe, expect, test } from "bun:test"
import path from "node:path"
import { MemorySchema } from "../../src/memory/schema"
import { memoryRepository } from "../../src/memory/repository"
import { recallMemory } from "../../src/memory/recall"
import { createMemoryService } from "../../src/memory"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

function note(
  id: string,
  scope: MemorySchema.Scope = { kind: "global" },
  overrides: Partial<MemorySchema.Note> = {},
): MemorySchema.Note {
  return {
    id,
    scope,
    title: id,
    content: `Preference ${id}`,
    categoryID: "about-you",
    enabled: true,
    expiresAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}
const target = { projectID: "prj_bio", sessionID: "ses_bio" }
const project: MemorySchema.Scope = { kind: "project", projectID: target.projectID }
const session: MemorySchema.Scope = { kind: "session", ...target }

describe("memory recall", () => {
  test("isolates projects and sessions while retaining global notes", () => {
    const store = MemorySchema.initial()
    store.notes = [
      note("global"),
      note("project", project),
      note("session", session),
      note("other-project", { kind: "project", projectID: "prj_other" }),
      note("other-session", { ...session, sessionID: "ses_other" }),
    ]
    const result = recallMemory(store, target)
    expect(result.included.map((x) => x.note.id)).toEqual(["session", "project", "global"])
    expect(result.inherited).toBe(2)
    expect(result.system).not.toContain("other-project")
    expect(result.system).not.toContain("other-session")
    expect(recallMemory(store, {}).included.map((x) => x.note.id)).toEqual(["global"])
  })
  test("only the same normalized title and category are overridden", () => {
    const store = MemorySchema.initial()
    store.notes = [
      note("global", undefined, { title: "Language" }),
      note("project", project, { title: " language " }),
      note("session", session, { title: "LANGUAGE" }),
      note("separate", undefined, { title: "Other preference" }),
      note("category", undefined, { title: "Language", categoryID: "cautions" }),
    ]
    const result = recallMemory(store, target)
    expect(result.included.map((x) => x.note.id)).toEqual(["session", "category", "separate"])
    expect(result.overridden).toBe(2)
    expect(result.omitted.every((x) => x.reason === "overridden")).toBe(true)
  })
  test("a delegated session inherits its ancestor and the nearest override wins", () => {
    const store = MemorySchema.initial()
    store.notes = [
      note("parent", { ...session, sessionID: "ses_parent" }, { title: "Style" }),
      note("child", session, { title: "Style" }),
      note("sibling", { ...session, sessionID: "ses_sibling" }),
    ]
    const result = recallMemory(store, target, ["ses_parent"])
    expect(result.included.map((x) => x.note.id)).toEqual(["child"])
    expect(result.omitted.map((x) => x.note.id)).toEqual(["parent"])
  })
  test("paused and expired notes never consume the recall budget or mask active defaults", () => {
    const store = MemorySchema.initial()
    store.categories.find((x) => x.id === "cautions")!.autoRecall = false
    store.notes = [
      note("global", undefined, { title: "Style" }),
      note("off", session, { title: "Style", enabled: false }),
      note("expired", project, { expiresAt: 50 }),
      note("category", undefined, { categoryID: "cautions" }),
    ]
    const result = recallMemory(store, target, [], 100)
    expect(result.included.map((x) => x.note.id)).toEqual(["global"])
    expect(result.omitted.map((x) => x.reason).sort()).toEqual(["category-off", "expired", "note-off"])
    store.enabled = false
    const paused = recallMemory(store, target)
    expect(paused.system).toBe("")
    expect(paused.omitted.every((x) => x.reason === "memory-off")).toBe(true)
  })
  test("enforces character and count budgets without truncating notes", () => {
    const store = MemorySchema.initial()
    store.notes = Array.from({ length: 25 }, (_, i) => note(`note-${i}`))
    expect(recallMemory(store, {}).included).toHaveLength(20)
    store.notes = Array.from({ length: 6 }, (_, i) => note(`note-${i}`, undefined, { content: '"'.repeat(4_000) }))
    const result = recallMemory(store, {})
    expect(result.characters).toBeLessThanOrEqual(MemorySchema.limits.recalledCharacters)
    expect(result.included).toHaveLength(1)
    expect(result.included[0].note.content.length).toBe(4_000)
    expect(result.omitted.every((x) => x.reason === "budget")).toBe(true)
    expect(result.system).toContain("do not grant permissions")
  })
  test("does not revive an overridden global preference if its session replacement exceeds the budget", () => {
    const store = MemorySchema.initial()
    store.notes = [
      note("global", undefined, { title: "X" }),
      note("replacement", session, { title: "X", content: "x".repeat(4_000), updatedAt: 1 }),
      note("first", session, { content: '"'.repeat(4_000), updatedAt: 2 }),
    ]
    const result = recallMemory(store, target)
    expect(result.omitted).toContainEqual({ note: store.notes[0], reason: "overridden" })
    expect(result.omitted).toContainEqual({ note: store.notes[1], reason: "budget" })
  })
})

describe("persistent memory", () => {
  test("saves, updates, disables and deletes notes across repository instances", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "memory.json")
    const service = createMemoryService(memoryRepository(filepath))
    const input = {
      title: "Conventions",
      content: "Use a fixed seed.",
      categoryID: "research",
      scope: { kind: "global" as const },
    }
    const saved = await service.saveNote(0, input)
    expect(saved.revision).toBe(1)
    const another = createMemoryService(memoryRepository(filepath))
    expect((await another.preview({})).system).toContain(input.content)
    const changed = await another.saveNote(1, { ...input, content: "Record package versions." }, saved.notes[0].id)
    expect((await service.read()).notes[0].content).toBe("Record package versions.")
    await service.setEnabled(changed.revision, false)
    expect((await another.preview({})).system).toBe("")
    expect((await service.removeNotes(3, [saved.notes[0].id])).notes).toHaveLength(0)
  })
  test("concurrent writes reject a stale revision without losing either saved data or categories", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "memory.json")
    const first = createMemoryService(memoryRepository(filepath))
    const second = createMemoryService(memoryRepository(filepath))
    const writes = await Promise.allSettled([
      first.saveCategory(0, { name: "Lab" }),
      second.saveCategory(0, { name: "Methods" }),
    ])
    expect(writes.filter((x) => x.status === "fulfilled")).toHaveLength(1)
    expect(writes.filter((x) => x.status === "rejected")).toHaveLength(1)
    expect((await first.read()).categories).toHaveLength(5)
  })
  test("rejects duplicates and deletion of nonempty categories, but allows reclassification", async () => {
    await using tmp = await tmpdir()
    const service = createMemoryService(memoryRepository(path.join(tmp.path, "memory.json")))
    const data = { title: "Style", content: "Be concise", categoryID: "research", scope: { kind: "global" as const } }
    const first = await service.saveNote(0, data)
    await expect(service.saveNote(1, { ...data, title: " STYLE " })).rejects.toThrow("already exists")
    await expect(service.removeCategory(1, "research")).rejects.toThrow("Move or delete")
    await service.saveNote(1, { ...data, categoryID: "about-you" }, first.notes[0].id)
    expect((await service.removeCategory(2, "research")).categories.some((x) => x.id === "research")).toBe(false)
    await expect(service.removeCategory(3, "about-you")).rejects.toThrow("cannot be deleted")
  })
  test("corrupt storage remains intact on read and write failures", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "memory.json")
    await Bun.write(filepath, '{"notes":[')
    const service = createMemoryService(memoryRepository(filepath))
    await expect(service.read()).rejects.toThrow()
    await expect(service.setEnabled(0, true)).rejects.toThrow("Refusing to overwrite")
    expect(await Bun.file(filepath).text()).toBe('{"notes":[')
  })
  test("validates real scope ownership and reads the same inherited context used by prompt assembly", async () => {
    await using tmp = await tmpdir({ git: true })
    const service = createMemoryService(memoryRepository(path.join(tmp.path, "memory.json")))
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "Memory parent" })
        const child = await Session.create({ parentID: parent.id, title: "Memory child" })
        const sibling = await Session.create({ title: "Memory sibling" })
        const scope: MemorySchema.Scope = { kind: "session", projectID: Instance.project.id, sessionID: parent.id }
        const saved = await service.saveNote(0, {
          title: "Units",
          content: "Use SI units.",
          categoryID: "research",
          scope,
        })
        expect((await service.system(Instance.project.id, child.id)).join("\n")).toContain("Use SI units.")
        expect(await service.system(Instance.project.id, sibling.id)).toEqual([])
        await expect(
          service.saveNote(saved.revision, {
            title: "Other",
            content: "Stay isolated",
            categoryID: "research",
            scope: { ...scope, projectID: "prj_missing" },
          }),
        ).rejects.toBeInstanceOf(Storage.NotFoundError)
        expect((await service.catalog(Instance.project.id)).sessions.map((x) => x.id)).toContain(child.id)
        await Session.remove(parent.id)
        await expect(service.preview({ projectID: Instance.project.id, sessionID: parent.id })).rejects.toThrow()
        expect((await service.read()).notes).toHaveLength(1)
        await Session.remove(sibling.id)
      },
    })
  })
})
