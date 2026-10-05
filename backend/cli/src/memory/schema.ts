import z from "zod"

export namespace MemorySchema {
  export const limits = { notes: 500, categories: 24, content: 4_000, recalledNotes: 20, recalledCharacters: 12_000 }
  export const ID = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/)
  export const Scope = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("global") }).strict(),
      z.object({ kind: z.literal("project"), projectID: ID }).strict(),
      z.object({ kind: z.literal("session"), projectID: ID, sessionID: ID }).strict(),
    ])
    .meta({ ref: "MemoryScope" })
  export type Scope = z.infer<typeof Scope>
  export const CategoryInput = z
    .object({
      name: z.string().trim().min(1).max(60),
      description: z.string().trim().max(500).default(""),
      autoRecall: z.boolean().default(true),
    })
    .strict()
  export const Category = CategoryInput.extend({
    id: ID,
    description: z.string().max(500),
    autoRecall: z.boolean(),
  }).meta({ ref: "MemoryCategory" })
  export type Category = z.infer<typeof Category>
  export const NoteInput = z
    .object({
      title: z.string().trim().min(1).max(100),
      content: z.string().trim().min(1).max(limits.content),
      categoryID: ID,
      scope: Scope,
      enabled: z.boolean().default(true),
      expiresAt: z.number().int().positive().nullable().default(null),
    })
    .strict()
  export const Note = NoteInput.extend({
    id: ID,
    createdAt: z.number(),
    updatedAt: z.number(),
    enabled: z.boolean(),
    expiresAt: z.number().int().positive().nullable(),
  }).meta({ ref: "MemoryNote" })
  export type Note = z.infer<typeof Note>
  const defaults: Category[] = [
    {
      id: "about-you",
      name: "About you",
      description: "Your background, working style and communication preferences.",
      autoRecall: true,
    },
    {
      id: "research",
      name: "Research preferences",
      description: "Preferred methods, reproducibility and reporting conventions.",
      autoRecall: true,
    },
    {
      id: "context",
      name: "Project context",
      description: "Background and decisions that future work should remember.",
      autoRecall: true,
    },
    {
      id: "cautions",
      name: "Cautions",
      description: "Known pitfalls and constraints to check before taking action.",
      autoRecall: true,
    },
  ]
  export const Store = z
    .object({
      version: z.literal(1),
      revision: z.number().int().nonnegative(),
      enabled: z.boolean(),
      categories: Category.array().max(limits.categories),
      notes: Note.array().max(limits.notes),
    })
    .meta({ ref: "MemoryStore" })
  export type Store = z.infer<typeof Store>
  export const initial = (): Store => ({
    version: 1,
    revision: 0,
    enabled: true,
    categories: defaults.map((x) => ({ ...x })),
    notes: [],
  })
  export const Target = z
    .object({ projectID: ID.optional(), sessionID: ID.optional() })
    .strict()
    .refine((target) => !target.sessionID || !!target.projectID, "A session requires a project")
  export type Target = z.infer<typeof Target>
  export const Reason = z.enum(["memory-off", "note-off", "category-off", "expired", "overridden", "budget"])
  export const Preview = z
    .object({
      enabled: z.boolean(),
      revision: z.number(),
      included: z.array(z.object({ note: Note, inherited: z.boolean() })),
      omitted: z.array(z.object({ note: Note, reason: Reason })),
      inherited: z.number(),
      overridden: z.number(),
      characters: z.number(),
      maxCharacters: z.number(),
      maxNotes: z.number(),
      system: z.string(),
    })
    .meta({ ref: "MemoryPreview" })
  export type Preview = z.infer<typeof Preview>
  export const Catalog = z
    .object({
      projects: z.array(z.object({ id: ID, name: z.string(), archived: z.boolean() })),
      sessions: z.array(z.object({ id: ID, title: z.string(), parentID: ID.optional(), archived: z.boolean() })),
    })
    .meta({ ref: "MemoryCatalog" })
  export const Revision = z.object({ revision: z.number().int().nonnegative() })
}
