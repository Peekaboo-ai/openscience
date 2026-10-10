import { afterAll, beforeAll, afterEach, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir, trustProject, fullAccessExecution } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Specialists } from "../../src/specialist"
import { SpecialistSchema } from "../../src/specialist/schema"
import { SpecialistRepository, specialistRepository } from "../../src/specialist/repository"
import { createSpecialistRoutes } from "../../src/server/routes/settings/specialists"
import { PermissionNext } from "../../src/permission/next"
import { SystemPrompt } from "../../src/session/system"
import { Skill } from "../../src/skill"
import { MCP } from "../../src/mcp"
import { Command } from "../../src/command"
import { Global } from "../../src/global"
import { Session } from "../../src/session"
import { SpecialistTool } from "../../src/tool/specialist"
import { SkillTool } from "../../src/tool/skill"
import { ToolVisibility } from "../../src/tool/visibility"

const skillFile = path.join(Global.Path.data, "user-skills/customize/SKILL.md")
beforeAll(async () => {
  await Bun.write(skillFile, Bun.file(path.resolve(import.meta.dir, "../../skills/research/customize/SKILL.md")))
})
afterAll(async () => {
  await Bun.file(skillFile).delete()
})

afterEach(async () => {
  const current = await SpecialistRepository.read()
  await SpecialistRepository.update(current.revision, (store) => {
    store.profiles = []
  })
})
const input = () =>
  SpecialistSchema.Input.parse({
    name: "single-cell-reviewer",
    displayName: "单细胞专家",
    description: "Review single-cell analyses",
    instructions: "Report biological replicates and uncertainty.",
    skillNames: ["customize"],
    connectors: [],
  })

test("settings CRUD persists experts, updates the real agent catalog, and restores built-ins", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const app = createSpecialistRoutes()
      const initial = await Specialists.list()
      expect(initial.profiles.map((x) => x.name)).toEqual(
        expect.arrayContaining(["biology", "chemistry", "physics", "ml", "data"]),
      )
      const post = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: initial.revision, profile: input() }),
      })
      expect(post.status).toBe(200)
      const saved = await post.json()
      const agent = await Agent.get(input().name)
      expect(agent?.mode).toBe("subagent")
      expect(agent?.displayName).toBe("单细胞专家")
      expect(agent?.prompt).toContain("Report biological replicates")
      expect(agent?.prompt).toContain("specialist")
      expect(agent?.connectors).toEqual([])
      expect(PermissionNext.evaluate("skill", "customize", agent!.permission).action).not.toBe("deny")
      expect(PermissionNext.evaluate("skill", "literature-review", agent!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("task", "*", agent!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("specialist", "*", agent!.permission).action).toBe("deny")
      expect((await SystemPrompt.render(agent!)).prompt).toContain("Selected skills:")
      const disabled = await Specialists.toggle(saved.revision, input().name, false)
      expect((await Agent.list()).some((x) => x.name === input().name)).toBe(false)
      expect((await Agent.get(input().name))?.disabled).toBe(true)
      const enabled = await Specialists.toggle(disabled.revision, input().name, true)
      expect((await Agent.list()).some((x) => x.name === input().name)).toBe(true)
      const paused = await Specialists.toggle(enabled.revision, "biology", false)
      expect((await Agent.list()).some((x) => x.name === "biology")).toBe(false)
      const reset = await Specialists.remove(paused.revision, "biology")
      expect((await Agent.list()).some((x) => x.name === "biology")).toBe(true)
      await Specialists.remove(reset.revision, input().name)
      expect(await Agent.get(input().name)).toBeUndefined()
    },
  })
})

test("rejects stale writes, immutable ID changes, reserved names and nonexistent capabilities", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const initial = await Specialists.list()
      const saved = await Specialists.save(initial.revision, input())
      await expect(
        Specialists.save(initial.revision, { ...input(), instructions: "stale" }, input().name),
      ).rejects.toMatchObject({ status: 409 })
      await expect(Specialists.save(saved.revision, { ...input(), name: "research" })).rejects.toMatchObject({
        status: 409,
      })
      await expect(
        Specialists.save(saved.revision, { ...input(), name: "renamed" }, input().name),
      ).rejects.toMatchObject({ status: 400 })
      await expect(
        Specialists.save(saved.revision, { ...input(), name: "unknown-skills", skillNames: ["not-installed"] }),
      ).rejects.toThrow("Unavailable skills")
      await expect(
        Specialists.save(saved.revision, { ...input(), name: "unknown-connector", connectors: ["missing"] }),
      ).rejects.toThrow("Unavailable connectors")
      expect((await Specialists.list()).profiles.find((x) => x.name === input().name)?.instructions).toBe(
        input().instructions,
      )
      const invalid = await createSpecialistRoutes().request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: saved.revision, profile: { ...input(), name: "../escape" } }),
      })
      expect(invalid.status).toBe(400)
    },
  })
})

test("custom profiles remain visible across projects without bypassing their permissions", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir({ config: { permission: { skill: { customize: "deny" }, bash: "deny" } } })
  await Instance.provide({
    directory: first.path,
    fn: async () => {
      await Specialists.save((await Specialists.list()).revision, input())
    },
  })
  await Instance.provide({
    directory: second.path,
    fn: async () => {
      await trustProject()
      const agent = await Agent.get(input().name)
      expect(agent).toBeDefined()
      expect(PermissionNext.evaluate("bash", "*", agent!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("skill", "customize", agent!.permission).action).toBe("deny")
      expect((await Skill.catalog(agent!.permission)).allowed).toHaveLength(0)
    },
  })
})

test("repository serializes competing writers and preserves corrupt data", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "specialists.json")
  const repository = specialistRepository(file)
  const results = await Promise.allSettled([
    repository.update(0, () => {}),
    specialistRepository(file).update(0, () => {}),
  ])
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1)
  expect((await repository.read()).revision).toBe(1)
  await Bun.write(file, '{"version":1,"profiles":')
  await expect(repository.update(1, () => {})).rejects.toThrow()
  expect(await Bun.file(file).text()).toBe('{"version":1,"profiles":')
  for (const invalid of ["[]", "42", "null", '""']) {
    await Bun.write(file, invalid)
    await expect(repository.read()).rejects.toThrow()
    await expect(repository.update(0, () => {})).rejects.toThrow()
    expect(await Bun.file(file).text()).toBe(invalid)
  }
})

test("customize is listed in lowercase, accepts legacy casing and unlocks the actual management tool", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await Command.get("customize")).toEqual(await Command.get("Customize"))
      expect(
        (await Command.list()).filter((item) => item.name.toLowerCase() === "customize").map((item) => item.name),
      ).toEqual(["customize"])
      expect((await Command.get("customize")).usage).toBe("/customize [question or specialist requirements]")
      const skill = (await Skill.catalog((await Agent.get("research"))!.permission)).allowed.find(
        (x) => x.name === "customize",
      )
      expect(skill?.allowed_tools).toContain("specialist")
      expect(await (await Command.get("Customize")).template).toContain("customize")
      const session = await Session.create({})
      const asked: string[] = []
      const ctx = {
        sessionID: session.id,
        messageID: "msg_specialist",
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => {},
        ask: async (input: { permission: string }) => {
          asked.push(input.permission)
        },
      }
      const loaded = await (
        await SkillTool.init({ agent: (await Agent.get("research"))! })
      ).execute({ name: "customize" }, ctx)
      expect("allowedTools" in loaded.metadata && loaded.metadata.allowedTools).toContain("specialist")
      expect(ToolVisibility.offered("specialist", { agent: (await Agent.get("research"))! })).toBe(false)
      expect(
        ToolVisibility.offered("specialist", {
          agent: (await Agent.get("research"))!,
          unlocked: new Set(["specialist"]),
        }),
      ).toBe(true)
      const tool = await SpecialistTool.init()
      const current = JSON.parse((await tool.execute({ action: "list" }, ctx)).output)
      const result = await tool.execute({ action: "create", revision: current.revision, profile: input() }, ctx)
      expect(JSON.parse(result.output).profile.displayName).toBe("单细胞专家")
      expect(asked).toContain("specialist")
      const child = await Session.create({ parentID: session.id })
      await expect(tool.execute({ action: "list" }, { ...ctx, sessionID: child.id })).rejects.toThrow("cannot change")
      const aborted = new AbortController()
      aborted.abort(new Error("cancelled"))
      await expect(tool.execute({ action: "list" }, { ...ctx, abort: aborted.signal })).rejects.toThrow("cancelled")
    },
  })
})

test("specialist reads honor explicit policy without action approvals and mutations retain the project mode boundary", () => {
  const access = { configured: "allow" as const, granted: "ask" as const, permission: "specialist" }
  for (const action of ["list", "get", "catalog"]) {
    expect(PermissionNext.risk("specialist", { action })).toBe("passive")
    expect(PermissionNext.modeAction({ ...access, mode: "ask", metadata: { action } })).toBe("allow")
    expect(PermissionNext.modeAction({ ...access, mode: "full", configured: "deny", metadata: { action } })).toBe(
      "deny",
    )
    expect(PermissionNext.modeAction({ ...access, mode: "full", configured: "ask", metadata: { action } })).toBe("ask")
  }
  for (const action of ["create", "update", "toggle", "remove"]) {
    expect(PermissionNext.modeAction({ ...access, mode: "ask", metadata: { action } })).toBe("ask")
    expect(PermissionNext.modeAction({ ...access, mode: "approve", metadata: { action } })).toBe("ask")
    expect(PermissionNext.modeAction({ ...access, mode: "full", metadata: { action } })).toBe("allow")
    expect(PermissionNext.modeAction({ ...access, mode: "full", configured: "deny", metadata: { action } })).toBe(
      "deny",
    )
  }
  expect(PermissionNext.modeAction({ ...access, mode: "full", metadata: { action: "future-action" } })).toBe("ask")
})

test("tool discovery pages large catalogs, retrieves one editable profile, and returns compact write receipts", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Promise.all(
        Array.from({ length: 45 }, (_, index) => {
          const name = `catalog-${String(index).padStart(2, "0")}`
          return Bun.write(
            path.join(dir, ".openscience/skill", name, "SKILL.md"),
            `---\nname: ${name}\ndescription: Catalog fixture ${"very long scientific description ".repeat(160)}\n---\nInstructions.`,
          )
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: trustProject,
    fn: async () => {
      const session = await Session.create({})
      const approvals: Array<{ permission: string; patterns: string[]; always: string[] }> = []
      const ctx = {
        sessionID: session.id,
        messageID: "msg_catalog",
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata() {},
        async ask(request: { permission: string; patterns: string[]; always: string[] }) {
          approvals.push(request)
        },
      }
      const tool = await SpecialistTool.init()
      const read = await tool.execute({ action: "catalog", kind: "skill", query: "Catalog fixture" }, ctx)
      const first = JSON.parse(read.output)
      expect(first.total).toBe(45)
      expect(first.items).toHaveLength(10)
      expect(first.nextOffset).toBe(10)
      expect("truncated" in read.metadata && read.metadata.truncated).toBe(false)
      expect(Buffer.byteLength(read.output)).toBeLessThan(8_000)
      const names: string[] = first.items.map((entry: { name: string }) => entry.name)
      for (const offset of [10, 30]) {
        const next = JSON.parse(
          (await tool.execute({ action: "catalog", query: "Catalog fixture", offset, limit: 20 }, ctx)).output,
        )
        names.push(...next.items.map((entry: { name: string }) => entry.name))
        if (offset === 30) expect(next.nextOffset).toBeNull()
      }
      expect(new Set(names).size).toBe(45)
      const targeted = JSON.parse((await tool.execute({ action: "catalog", query: "catalog-42" }, ctx)).output)
      expect(targeted.items.map((entry: { name: string }) => entry.name)).toEqual(["catalog-42"])
      expect(
        (await Specialists.catalog()).skills.find((entry) => entry.name === "catalog-42")?.description.length,
      ).toBeGreaterThan(4000)

      const before = await Specialists.list()
      const profile = { ...input(), instructions: "Keep this instruction. ".repeat(100) }
      const created = JSON.parse(
        (await tool.execute({ action: "create", profile, revision: before.revision }, ctx)).output,
      )
      expect(created.profile.name).toBe(profile.name)
      expect(created.profile.instructions).toBeUndefined()
      const listed = JSON.parse((await tool.execute({ action: "list", query: profile.name }, ctx)).output)
      expect(listed.items).toHaveLength(1)
      expect(listed.items[0].instructions).toBeUndefined()
      const found = JSON.parse((await tool.execute({ action: "get", name: profile.name }, ctx)).output)
      expect(found.profile.instructions).toBe(profile.instructions.trim())
      expect(found.revision).toBe(created.revision)
      await expect(
        tool.execute(
          { action: "list" },
          {
            ...ctx,
            ask: async () => {
              throw new Error("permission denied")
            },
          },
        ),
      ).rejects.toThrow("permission denied")
      expect(approvals.find((entry) => entry.patterns[0] === "catalog")?.always).toEqual(["catalog"])
      expect(approvals.find((entry) => entry.patterns[0] === `get:${profile.name}`)?.always).toEqual(["get:*"])
      const toggled = JSON.parse(
        (await tool.execute({ action: "toggle", name: profile.name, enabled: false, revision: found.revision }, ctx))
          .output,
      )
      expect(toggled.profile.enabled).toBe(false)
      const removed = JSON.parse(
        (await tool.execute({ action: "remove", name: profile.name, revision: toggled.revision }, ctx)).output,
      )
      expect(removed.profile).toBeNull()
    },
  })
})

// Windows 需为两个真实 MCP 进程建立 Job Object 所有权，冷启动与回收可能超过普通单元测试时限。
test(
  "connector restrictions select exact registered connectors, including overlapping names",
  async () => {
    await using tmp = await tmpdir()
    const fixture = path.resolve(import.meta.dir, "../fixture/mcp-tool-cache.mjs")
    await Bun.write(
      path.join(tmp.path, "openscience.json"),
      JSON.stringify({
        mcp: Object.fromEntries(
          ["lab", "lab_extra"].map((name) => [
            name,
            {
              type: "local",
              command: [process.execPath, fixture],
              environment: { OPENSCIENCE_MCP_LIST_MARKER: path.join(tmp.path, `${name}.txt`) },
            },
          ]),
        ),
      }),
    )
    await using access = await fullAccessExecution()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const selected = Object.keys(await MCP.tools(["lab"]))
        expect(selected, JSON.stringify(await MCP.status())).toEqual(["lab_echo"])
        expect(Object.keys(await MCP.tools([]))).toEqual([])
        expect(Object.keys(await MCP.tools()).sort()).toEqual(["lab_echo", "lab_extra_echo"])
      },
    })
  },
  process.platform === "win32" ? 60_000 : 15_000,
)
