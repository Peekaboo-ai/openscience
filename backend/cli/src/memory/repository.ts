import path from "node:path"
import { Global } from "../global"
import { JsonStore } from "../util/jsonstore"
import { MemorySchema } from "./schema"

export class MemoryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

export function memoryRepository(filepath = path.join(Global.Path.data, "memory.json")) {
  const parse = (raw: unknown) => {
    const empty = !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0
    const result = MemorySchema.Store.safeParse(empty ? MemorySchema.initial() : raw)
    if (!result.success) throw new Error("Memory storage is invalid; refusing to overwrite it")
    const store = result.data
    if (
      new Set(store.categories.map((x) => x.id)).size !== store.categories.length ||
      new Set(store.notes.map((x) => x.id)).size !== store.notes.length ||
      store.notes.some((x) => !store.categories.some((category) => category.id === x.categoryID))
    ) {
      throw new Error("Memory storage has inconsistent references; refusing to overwrite it")
    }
    return store
  }
  return {
    read: async () => parse(await JsonStore.read(filepath, { strict: true })),
    async update(revision: number, change: (store: MemorySchema.Store) => void) {
      let saved: MemorySchema.Store | undefined
      await JsonStore.update(filepath, (raw) => {
        const store = parse(raw)
        // 整体版本在文件锁内校验，防止多个窗口的编辑或清空请求覆盖新笔记。
        if (store.revision !== revision)
          throw new MemoryError(
            "Memory changed in another window. Refresh and try again; your draft is preserved.",
            409,
          )
        change(store)
        store.revision++
        saved = parse(store)
        return saved
      })
      return saved!
    },
  }
}
