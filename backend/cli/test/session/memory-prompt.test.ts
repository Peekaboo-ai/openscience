import { expect, test } from "bun:test"
import { Memory } from "../../src/memory"
import { ArtifactStore } from "../../src/artifact/store"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

test("actual model requests receive saved memory, edits on the next turn, and no memory after pausing", async () => {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages?: { role: string; content: unknown }[] }
      requests.push(JSON.stringify(body.messages?.filter((x) => x.role === "system")))
      const chunk = (content?: string) => ({
        id: "chatcmpl-memory",
        object: "chat.completion.chunk",
        created: 1,
        model: STRESS_PROVIDER_MODEL,
        choices: [
          { index: 0, delta: content ? { role: "assistant", content } : {}, finish_reason: content ? null : "stop" },
        ],
        ...(!content ? { usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } } : {}),
      })
      return new Response(
        `data: ${JSON.stringify(chunk("Understood."))}\n\ndata: ${JSON.stringify(chunk())}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`http://127.0.0.1:${server.port}/v1`) })
  let savedID: string | undefined
  const previous = await Memory.read()
  try {
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: "Memory integration" })
        const data = {
          title: "Report style",
          content: "MEMORY_BEFORE_29C",
          categoryID: "about-you",
          scope: { kind: "session" as const, projectID: Instance.project.id, sessionID: session.id },
        }
        const saved = await Memory.saveNote(previous.revision, data)
        savedID = saved.notes.find((x) => x.title === data.title && x.content === data.content)!.id
        const prompt = () =>
          SessionPrompt.prompt({
            sessionID: session.id,
            agent: "research",
            delegation: false,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
            parts: [{ type: "text", text: "Reply briefly." }],
          })
        await prompt()
        expect(requests.some((x) => x.includes("MEMORY_BEFORE_29C"))).toBe(true)
        requests.length = 0
        await Memory.saveNote(saved.revision, { ...data, content: "MEMORY_AFTER_73D" }, savedID)
        await prompt()
        expect(requests.some((x) => x.includes("MEMORY_AFTER_73D"))).toBe(true)
        expect(requests.some((x) => x.includes("MEMORY_BEFORE_29C"))).toBe(false)
        requests.length = 0
        await Memory.setEnabled((await Memory.read()).revision, false)
        await prompt()
        expect(requests.some((x) => x.includes("MEMORY_AFTER_73D"))).toBe(false)
        await Session.remove(session.id)
      },
    })
  } finally {
    if (savedID) await Memory.removeNotes((await Memory.read()).revision, [savedID])
    await Memory.setEnabled((await Memory.read()).revision, previous.enabled)
    await server.stop(true)
    await ArtifactStore.reset()
  }
}, 30_000)
