import path from "node:path"
import { Global } from "../global"
import { JsonStore } from "../util/jsonstore"
import { SpecialistSchema } from "./schema"

export class SpecialistError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

export function specialistRepository(filepath = path.join(Global.Path.data, "specialists.json")) {
  const parse = (raw: Record<string, unknown>) => {
    const empty = raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0
    const parsed = SpecialistSchema.Store.safeParse(empty ? { version: 1, revision: 0, profiles: [] } : raw)
    if (!parsed.success || new Set(parsed.data.profiles.map((x) => x.name)).size !== parsed.data.profiles.length)
      throw new Error("Specialist storage is invalid. Existing profiles have been preserved.")
    return parsed.data
  }
  return {
    read: async () => parse(await JsonStore.read(filepath, { strict: true })),
    async update(revision: number, change: (store: SpecialistSchema.Store) => void) {
      let saved: SpecialistSchema.Store | undefined
      await JsonStore.update(filepath, (raw) => {
        const store = parse(raw)
        // 文件锁内校验版本，防止设置窗口与 Customize 对话相互覆盖。
        if (revision !== store.revision)
          throw new SpecialistError(
            "Specialists changed in another window. Reload the latest version before saving; your draft is preserved.",
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

export const SpecialistRepository = specialistRepository()
