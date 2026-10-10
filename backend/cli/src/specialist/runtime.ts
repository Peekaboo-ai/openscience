import type { Agent } from "../agent/agent"
import { PermissionNext } from "../permission/next"
import PROMPT_SPECIALIST from "../agent/prompt/specialist.txt"
import { SpecialistSchema } from "./schema"

const colors = {
  neutral: "#808080",
  blue: "#3B82F6",
  purple: "#8B5CF6",
  green: "#22C55E",
  orange: "#F97316",
  pink: "#EC4899",
}

export function specialistAgents(base: Record<string, Agent.Info>, profiles: SpecialistSchema.Profile[]) {
  const agents = { ...base }
  for (const profile of profiles) {
    const original = base[profile.name]
    if (profile.source === "builtin" && (!original?.native || original.mode !== "subagent")) continue
    if (profile.source === "custom" && original) continue
    if (profile.source === "configured") continue
    const inherited = original?.permission ?? base.research.permission
    const restrictions: PermissionNext.Ruleset = [
      { permission: "specialist", pattern: "*", action: "deny" },
      ...(original
        ? []
        : ["task", "question", "todowrite"].map((permission) => ({
            permission,
            pattern: "*",
            action: "deny" as const,
          }))),
      ...(profile.skillNames === null
        ? []
        : [
            { permission: "skill", pattern: "*", action: "deny" as const },
            ...profile.skillNames.map((name) => ({
              permission: "skill",
              pattern: name,
              action: PermissionNext.evaluate("skill", name, inherited).action,
            })),
          ]),
    ]
    const prompt =
      original?.prompt ??
      PROMPT_SPECIALIST.replace("{label}", profile.displayName).replace(
        "{focus}",
        profile.description || "the research tasks delegated by the lead",
      )
    agents[profile.name] = {
      ...original,
      name: profile.name,
      displayName: profile.displayName,
      icon: profile.icon,
      mode: "subagent",
      native: profile.source === "builtin",
      hidden: !profile.enabled,
      disabled: !profile.enabled,
      description: profile.description,
      color: colors[profile.color],
      prompt: [
        prompt,
        profile.instructions && `\n<specialist-instructions>\n${profile.instructions}\n</specialist-instructions>`,
      ]
        .filter(Boolean)
        .join("\n"),
      permission: PermissionNext.merge(inherited, restrictions),
      options: { ...original?.options },
      skillNames: profile.skillNames ?? undefined,
      connectors: profile.connectors ?? undefined,
    }
  }
  return agents
}
