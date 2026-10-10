import z from "zod"
import { Tool } from "./tool"
import { Specialists } from "../specialist"
import { SpecialistSchema } from "../specialist/schema"
import { Agent } from "../agent/agent"
import { Session } from "../session"
import { specialistPage, specialistSummary } from "../specialist/discovery"
import DESCRIPTION from "./specialist.txt"

export const SpecialistTool = Tool.define("specialist", {
  description: DESCRIPTION,
  parameters: z.object({
    action: z.enum(["list", "get", "catalog", "create", "update", "toggle", "remove"]),
    query: z.string().trim().max(200).optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(20).optional(),
    kind: z.enum(["skill", "connector"]).optional(),
    revision: z.number().int().nonnegative().optional(),
    name: SpecialistSchema.ID.optional(),
    profile: SpecialistSchema.Input.optional(),
    enabled: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    if ((await Agent.get(ctx.agent))?.mode === "subagent" || (await Session.get(ctx.sessionID)).parentID)
      throw new Error("Specialists cannot change specialist profiles. Return the proposed changes to the lead.")
    const read = input.action === "list" || input.action === "get" || input.action === "catalog"
    await ctx.ask({
      permission: "specialist",
      patterns: [
        input.action === "get"
          ? `get:${input.name ?? ""}`
          : read
            ? input.action
            : `${input.action}:${input.name ?? input.profile?.name ?? "profile"}`,
      ],
      always: read ? [input.action === "get" ? "get:*" : input.action] : ["*"],
      metadata: { action: input.action, name: input.name ?? input.profile?.name },
    })
    if (ctx.abort.aborted) throw ctx.abort.reason
    const result = await (async () => {
      if (input.action === "list") {
        const snapshot = await Specialists.list()
        const page = specialistPage(snapshot.profiles, input)
        return { ...page, revision: snapshot.revision, items: page.items.map(specialistSummary) }
      }
      if (input.action === "get") {
        if (!input.name) throw new Error("An agent name is required")
        const snapshot = await Specialists.list()
        const profile = snapshot.profiles.find((entry) => entry.name === input.name)
        if (!profile) throw new Error("Specialist no longer exists")
        return { revision: snapshot.revision, profile }
      }
      if (input.action === "catalog") {
        const catalog = await Specialists.catalog()
        const entries = [
          ...catalog.skills.map((entry) => ({ ...entry, kind: "skill" as const })),
          ...catalog.connectors.map((entry) => ({ ...entry, description: "", kind: "connector" as const })),
        ].filter((entry) => !input.kind || entry.kind === input.kind)
        const page = specialistPage(entries, input)
        return {
          ...page,
          items: page.items.map((entry) => ({
            ...entry,
            description: entry.description.slice(0, 240),
            descriptionTruncated: entry.description.length > 240,
          })),
        }
      }
      if (input.revision === undefined) throw new Error("Read specialist list or get first and pass its revision")
      if (input.action === "create" || input.action === "update") {
        if (!input.profile) throw new Error("A complete profile is required")
        if (input.action === "update" && !input.name) throw new Error("The existing agent name is required")
        return Specialists.save(input.revision, input.profile, input.action === "update" ? input.name : undefined)
      }
      if (!input.name) throw new Error("An agent name is required")
      if (input.action === "toggle") {
        if (input.enabled === undefined) throw new Error("enabled is required")
        return Specialists.toggle(input.revision, input.name, input.enabled)
      }
      return Specialists.remove(input.revision, input.name)
    })()
    // 写入回执只包含目标专家，避免把其他专家的全部指令再次塞入上下文。
    const profile =
      "profiles" in result
        ? result.profiles.find((entry) => entry.name === (input.name ?? input.profile?.name))
        : undefined
    const output =
      "profiles" in result
        ? {
            revision: result.revision,
            name: input.name ?? input.profile?.name,
            profile: profile ? specialistSummary(profile) : null,
          }
        : result
    return {
      title: `Specialists · ${input.action}`,
      metadata: { action: input.action },
      output: JSON.stringify(output),
    }
  },
})
