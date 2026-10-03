import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { UsageLogging } from "../../src/session/usage-logging"
import { UsageStats } from "../../src/session/usage-stats"
import { UsageQuery } from "../../src/session/usage-stats-schema"
import { Storage } from "../../src/storage/storage"
import { tmpdir, trustProject } from "../fixture/fixture"
import { stressProviderConfig } from "../fixture/stress-provider"

test("actual provider streams record numeric usage without trace-sharing consent or research content", async () => {
  await UsageLogging.setEnabled(false)
  using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const base = { id: "chatcmpl-usage", object: "chat.completion.chunk", created: 1, model: "fixture-model" }
      return new Response(
        [
          { ...base, choices: [{ index: 0, delta: { content: "PRIVATE_ANSWER" }, finish_reason: null }] },
          {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 917,
              completion_tokens: 83,
              total_tokens: 1_000,
              prompt_tokens_details: { cached_tokens: 120 },
              completion_tokens_details: { reasoning_tokens: 20 },
            },
          },
        ]
          .map((item) => `data: ${JSON.stringify(item)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${provider.url}v1`) })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      const session = await Session.create({ title: "Numeric usage" })
      const model = await Provider.getModel("stress", "fixture-model")
      const agent = await Agent.get("research")
      if (!agent) throw new Error("Missing research agent")
      const result = await LLM.stream({
        user: {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          agent: "research",
          effort: "normal",
          time: { created: Date.now() },
          model: { providerID: model.providerID, modelID: model.id },
        },
        sessionID: session.id,
        model,
        agent,
        system: ["PRIVATE_SYSTEM"],
        messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
        tools: {},
        abort: new AbortController().signal,
      })
      await result.consumeStream()
      const report = await UsageStats.report(UsageQuery.parse({ range: "all", project: Instance.project.id }), true)
      expect(report.totals.total).toBe(1_000)
      expect(report.totals.tokens).toEqual({ input: 797, output: 83, reasoning: 20, cacheRead: 120, cacheWrite: 0 })
      expect(report.totals.background).toBe(1)
      expect(report.totals.requests).toBe(1)
      for (const key of await Storage.list(["usage"])) {
        const record = await Storage.read<Record<string, unknown>>(key)
        if (record.projectID !== Instance.project.id) continue
        expect(JSON.stringify(record)).not.toMatch(/PRIVATE_(?:SYSTEM|PROMPT|ANSWER)/)
        expect(record).not.toHaveProperty("content")
        expect(record).not.toHaveProperty("cost")
        expect(record).not.toHaveProperty("costSource")
      }
      await Session.remove(session.id)
      const retained = await UsageStats.report(UsageQuery.parse({ range: "all", project: Instance.project.id }), true)
      expect(retained.totals.total).toBe(1_000)
    },
  })
})
