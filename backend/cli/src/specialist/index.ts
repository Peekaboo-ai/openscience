import { Agent } from "../agent/agent"
import { Config } from "../config/config"
import { Skill } from "../skill"
import { SpecialistSchema } from "./schema"
import { SpecialistError, SpecialistRepository, specialistRepository } from "./repository"
import { BusEvent } from "../bus/bus-event"
import { GlobalBus } from "../bus/global"
import z from "zod"

export const SpecialistUpdated = BusEvent.define("specialist.updated", z.object({ revision: z.number() }))

const identities: Record<
  string,
  { displayName: string; icon: SpecialistSchema.Input["icon"]; color: SpecialistSchema.Input["color"] }
> = {
  biology: { displayName: "Biology", icon: "flask", color: "green" },
  chemistry: { displayName: "Chemistry", icon: "flask", color: "pink" },
  physics: { displayName: "Physics", icon: "atom", color: "orange" },
  ml: { displayName: "Machine learning", icon: "brain", color: "purple" },
  data: { displayName: "Data", icon: "chart", color: "blue" },
  explore: { displayName: "Explore", icon: "search", color: "neutral" },
  general: { displayName: "General", icon: "sparkles", color: "neutral" },
}

// 旧角色名仍被配置兼容层保留，不能用新专家意外复活这些入口。
const reserved = new Set([
  "review",
  "reviewer",
  "artifact-reviewer",
  "researchagent-test",
  "write",
  "execute",
  "task",
  "literature-review",
  "critique",
  "physics-critique",
  "docs",
])

export function createSpecialists(repository: ReturnType<typeof specialistRepository> = SpecialistRepository) {
  const snapshot = async (store: SpecialistSchema.Store) => {
    const base = await Agent.definitions()
    const profiles: SpecialistSchema.Profile[] = Object.values(base)
      .filter((agent) => agent.mode !== "primary" && !agent.hidden)
      .map((agent) => ({
        ...SpecialistSchema.Input.parse({
          name: agent.name,
          displayName: agent.name,
          description: agent.description ?? "",
        }),
        ...identities[agent.name],
        source: agent.native ? "builtin" : "configured",
        updatedAt: 0,
        ...(agent.native
          ? store.profiles.find((entry) => entry.name === agent.name && entry.source === "builtin")
          : {}),
      }))
    profiles.push(...store.profiles.filter((profile) => profile.source === "custom" && !base[profile.name]))
    return { revision: store.revision, profiles }
  }
  const list = async () => snapshot(await repository.read())
  const catalog = async () => {
    const [skills, cfg] = await Promise.all([
      Skill.catalog((await Agent.get("research"))!.permission),
      Config.getExecution(),
    ])
    return {
      skills: skills.allowed.map(({ name, description, category }) => ({ name, description, category })),
      connectors: Object.entries(cfg.mcp ?? {}).map(([name, value]) => ({ name, enabled: value.enabled !== false })),
    }
  }
  const validate = async (input: SpecialistSchema.Input, previous?: SpecialistSchema.Profile) => {
    const capabilities = await catalog()
    for (const key of ["skillNames", "connectors"] as const) {
      const available = new Set(
        (key === "skillNames" ? capabilities.skills : capabilities.connectors).map((x) => x.name),
      )
      // 已保存但暂时离线的能力允许保留；新附加能力必须来自当前服务真实目录。
      const unknown = input[key]?.filter((name) => !available.has(name) && !previous?.[key]?.includes(name))
      if (unknown?.length)
        throw new SpecialistError(
          `Unavailable ${key === "skillNames" ? "skills" : "connectors"}: ${unknown.join(", ")}`,
        )
    }
  }
  return {
    list,
    catalog,
    async save(revision: number, raw: SpecialistSchema.Input, name?: string) {
      const input = SpecialistSchema.Input.parse(raw)
      const existing = (await list()).profiles.find((x) => x.name === (name ?? input.name))
      if (name && !existing) throw new SpecialistError("Specialist no longer exists", 404)
      if (existing?.source === "configured")
        throw new SpecialistError(
          "This specialist is managed by the agent configuration. Duplicate it to create an editable profile.",
        )
      if (name && name !== input.name) throw new SpecialistError("Agent ID cannot be changed after creation")
      if (
        !name &&
        ((await Agent.definitions())[input.name] ||
          (await Config.getExecution()).agent?.[input.name] ||
          identities[input.name] ||
          existing ||
          reserved.has(input.name))
      )
        throw new SpecialistError("This agent ID is already in use or reserved", 409)
      await validate(input, existing)
      const saved = await repository.update(revision, (store) => {
        if (!name && store.profiles.some((x) => x.name === input.name))
          throw new SpecialistError("Agent ID already exists", 409)
        const profile: SpecialistSchema.Profile = {
          ...input,
          source: existing?.source ?? "custom",
          updatedAt: Date.now(),
        }
        store.profiles = [...store.profiles.filter((x) => x.name !== input.name), profile]
      })
      GlobalBus.emit("event", {
        directory: "global",
        payload: { type: SpecialistUpdated.type, properties: { revision: saved.revision } },
      })
      return snapshot(saved)
    },
    async toggle(revision: number, name: string, enabled: boolean) {
      const entry = (await list()).profiles.find((x) => x.name === name)
      if (!entry) throw new SpecialistError("Specialist no longer exists", 404)
      return this.save(revision, SpecialistSchema.Input.strip().parse({ ...entry, enabled }), name)
    },
    async remove(revision: number, name: string) {
      const entry = (await list()).profiles.find((x) => x.name === name)
      if (!entry) throw new SpecialistError("Specialist no longer exists", 404)
      if (entry.source === "configured")
        throw new SpecialistError("This specialist is managed by the agent configuration")
      // 内置专家删除覆盖记录即恢复默认，自定义专家才真正删除。
      const saved = await repository.update(revision, (store) => {
        store.profiles = store.profiles.filter((x) => x.name !== name)
      })
      GlobalBus.emit("event", {
        directory: "global",
        payload: { type: SpecialistUpdated.type, properties: { revision: saved.revision } },
      })
      return snapshot(saved)
    },
  }
}

export const Specialists = createSpecialists()
