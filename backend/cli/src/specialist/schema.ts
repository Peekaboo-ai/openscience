import z from "zod"

export namespace SpecialistSchema {
  export const ID = z
    .string()
    .regex(
      /^[a-z][a-z0-9_-]{0,63}$/,
      "Use a lowercase letter, then letters, numbers, hyphens or underscores (up to 64 characters)",
    )
  export const Icons = ["brain", "flask", "atom", "code", "chart", "book", "search", "sparkles"] as const
  export const Colors = ["neutral", "blue", "purple", "green", "orange", "pink"] as const
  const names = z
    .array(z.string().trim().min(1).max(200))
    .max(2000)
    .refine((value) => new Set(value).size === value.length, "Capability names must be unique")
  export const Input = z
    .object({
      name: ID,
      displayName: z.string().trim().min(1).max(100),
      description: z.string().trim().max(2000).default(""),
      instructions: z.string().trim().max(32000).default(""),
      icon: z.enum(Icons).default("brain"),
      color: z.enum(Colors).default("neutral"),
      enabled: z.boolean().default(true),
      skillNames: names.nullable().default(null),
      connectors: names.nullable().default(null),
    })
    .strict()
    .meta({ ref: "SpecialistInput" })
  export type Input = z.infer<typeof Input>
  export const Profile = Input.extend({
    source: z.enum(["builtin", "custom", "configured"]),
    updatedAt: z.number(),
  }).meta({ ref: "SpecialistProfile" })
  export type Profile = z.infer<typeof Profile>
  export const Store = z
    .object({ version: z.literal(1), revision: z.number().int().nonnegative(), profiles: Profile.array().max(500) })
    .strict()
  export type Store = z.infer<typeof Store>
  export const Snapshot = z
    .object({ revision: z.number(), profiles: Profile.array() })
    .meta({ ref: "SpecialistSnapshot" })
  export const Catalog = z
    .object({
      skills: z.object({ name: z.string(), description: z.string(), category: z.string().optional() }).array(),
      connectors: z.object({ name: z.string(), enabled: z.boolean() }).array(),
    })
    .meta({ ref: "SpecialistCatalog" })
}
