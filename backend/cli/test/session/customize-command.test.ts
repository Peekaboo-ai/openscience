import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { HarnessState } from "../../src/harness/state"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Specialists } from "../../src/specialist"
import { SpecialistSchema } from "../../src/specialist/schema"
import { tmpdir, trustProject, fullAccessExecution } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

afterEach(() => HarnessState.reset())

for (const entry of ["customize", "Customize", "prompt", "create"] as const) {
  test(`${entry} preserves the request and preloads customize before the first model step`, async () => {
    const requests: Array<{ messages: unknown; tools?: Array<{ function: { name: string } }> }> = []
    const profile = SpecialistSchema.Input.parse({
      name: "routing-specialist",
      displayName: "Routing specialist",
      instructions: "Review evidence and uncertainty.",
    })
    let step = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          messages: Array<{ role: string; content: string; tool_call_id?: string }>
        }
        requests.push(body)
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-customize",
            object: "chat.completion.chunk",
            created: 1,
            model: STRESS_PROVIDER_MODEL,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        if (entry === "create" && JSON.stringify(body.messages).includes("Methods and deliverables") && ++step <= 2) {
          // 用真实协议夹具驱动管理工具与权限检查，验证写入链路；模型语义另做在线评估。
          const listed = body.messages.find((message) => message.tool_call_id === "call_list")
          const args =
            step === 1
              ? { action: "list" }
              : { action: "create", revision: JSON.parse(listed!.content).revision, profile }
          return new Response(
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: step === 1 ? "call_list" : "call_create",
                    type: "function",
                    function: { name: "specialist", arguments: JSON.stringify(args) },
                  },
                ],
              },
              null,
            ) +
              chunk({}, "tool_calls") +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        return new Response(
          chunk({ role: "assistant", content: "I can explain and help design specialists." }, null) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    try {
      await using access = await fullAccessExecution()
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`${server.url.origin}/v1`),
        init: async (dir) => {
          await Bun.write(
            path.join(dir, ".openscience/skill/customize/SKILL.md"),
            Bun.file(path.resolve(import.meta.dir, "../../skills/research/customize/SKILL.md")),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: trustProject,
        fn: async () => {
          const before = await Specialists.list()
          const session = await Session.create({ title: "Customize routing regression", workspace: "project" })
          const args =
            entry === "create"
              ? "Create a routing-specialist expert to review evidence and uncertainty, with all capabilities available."
              : '你能为我做些什么？ Literal !`echo must-not-run` and $& "$ARGUMENTS".'
          const text = `/customize ${args}`
          const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }
          const result =
            entry === "prompt"
              ? await SessionPrompt.prompt({ sessionID: session.id, model, parts: [{ type: "text", text }] })
              : await SessionPrompt.command({
                  sessionID: session.id,
                  command: entry === "create" ? "customize" : entry,
                  arguments: args,
                  model: `${model.providerID}/${model.modelID}`,
                  effort: "ultra",
                  delegation: false,
                })
          expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
          const messages = await Session.messages({ sessionID: session.id })
          const visible = messages
            .filter((message) => message.info.role === "user")
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
          expect(visible).toHaveLength(1)
          expect(visible[0]).toMatchObject({ type: "text", text })
          const calls = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
          expect(calls.map((call) => call.tool)).toEqual(
            entry === "create" ? ["skill", "specialist", "specialist"] : ["skill"],
          )
          expect(calls[0].state).toMatchObject({
            status: "completed",
            input: { name: "customize" },
            metadata: { invoked: true },
          })
          const first = requests.find((request) =>
            JSON.stringify(request.messages).includes("Methods and deliverables"),
          )!
          expect(first).toBeDefined()
          expect(first.tools?.map((tool) => tool.function.name)).toContain("specialist")
          expect(JSON.stringify(first.messages)).toContain("First match the user's intent")
          expect(JSON.stringify(first.messages)).not.toContain("Load the customize skill with skill({name:")
          const after = await Specialists.list()
          if (entry === "create") {
            expect(calls.every((call) => call.state.status === "completed")).toBe(true)
            expect(after.profiles.find((entry) => entry.name === profile.name)).toMatchObject(profile)
            await Specialists.remove(after.revision, profile.name)
          } else expect(after).toEqual(before)
          if (entry !== "prompt")
            expect(messages.find((message) => message.info.role === "user")?.info).toMatchObject({
              effort: "ultra",
              delegation: false,
            })
        },
      })
    } finally {
      server.stop(true)
    }
  }, 30_000)
}
