import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Bus } from "../../src/bus"
import { PermissionNext } from "../../src/permission/next"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"
import { Sandbox } from "../../src/sandbox/sandbox"

test("an unavailable execution sandbox stops the turn after the first denied shell call", async () => {
  if (Sandbox.available()) return
  const provider = repeatingProvider(8, "bash", { command: "echo should-not-run", description: "Inspect runtime" })
  try {
    await using tmp = await tmpdir({
      git: true,
      config: stressProviderConfig(`http://127.0.0.1:${provider.server.port}/v1`),
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: "execution denied" })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          delegation: false,
          parts: [{ type: "text", text: "Inspect the runtime with a shell command." }],
        })
        const messages = await Session.messages({ sessionID: session.id })
        const calls = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && p.tool === "bash")
        expect(provider.issued()).toBe(1)
        expect(calls).toHaveLength(1)
        expect(calls[0].type === "tool" && calls[0].state.status).toBe("error")
        const assistant = messages.findLast((m) => m.info.role === "assistant")
        expect(assistant?.info.role === "assistant" && assistant.info.error?.data.message).toContain(
          "Execution is blocked before any command starts",
        )
        expect(assistant?.info.role === "assistant" && assistant.info.error?.data.message).toContain(
          "Full access for this project",
        )
      },
    })
  } finally {
    provider.server.stop(true)
  }
}, 30_000)

/** An OpenAI-compatible provider that answers every request with the same
 *  tool call until `calls` have gone out, then with text. */
function repeatingProvider(calls: number, tool: string, args: Record<string, unknown>) {
  let issued = 0
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-gate",
      object: "chat.completion.chunk",
      created: 1,
      model: STRESS_PROVIDER_MODEL,
      choices: [{ index: 0, delta: finish ? {} : delta, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } : {}),
    })}\n\n`
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      // Title and summary requests share the endpoint; only a request that
      // offers the tool is the research turn.
      const offered = await request
        .json()
        .then((body: { tools?: Array<{ function?: { name?: string } }> }) =>
          (body.tools ?? []).some((item) => item.function?.name === tool),
        )
        .catch(() => false)
      const body =
        offered && issued < calls
          ? [
              chunk({ role: "assistant", content: "" }, null),
              chunk(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_gate_${++issued}`,
                      type: "function",
                      function: { name: tool, arguments: JSON.stringify(args) },
                    },
                  ],
                },
                null,
              ),
              chunk({}, "tool_calls"),
            ]
          : [chunk({ role: "assistant", content: "done" }, null), chunk({}, "stop")]
      return new Response(`${body.join("")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return { server, issued: () => issued }
}

test("unchanged completed results cannot loop indefinitely even when repeats are approved", async () => {
  const provider = repeatingProvider(12, "glob", { pattern: "*.md" })
  try {
    await using tmp = await tmpdir({
      git: true,
      config: {
        ...stressProviderConfig(`http://127.0.0.1:${provider.server.port}/v1`),
        permission: { doom_loop: "allow" },
      },
    })
    await Bun.write(`${tmp.path}/README.md`, "# fixture\n")
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: "no progress gate" })
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, async ({ properties }) => {
          if (properties.sessionID === session.id && properties.permission === "doom_loop")
            await PermissionNext.reply({ requestID: properties.id, reply: "once" })
        })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          delegation: false,
          parts: [{ type: "text", text: "List the markdown files repeatedly." }],
        }).finally(unsubscribe)
        const messages = await Session.messages({ sessionID: session.id })
        expect(provider.issued()).toBeGreaterThanOrEqual(3)
        expect(provider.issued()).toBeLessThanOrEqual(6)
        expect(
          messages
            .flatMap((message) => message.parts)
            .some((part) => part.type === "text" && part.text.includes("unchanged results three times")),
        ).toBe(true)
      },
    })
  } finally {
    provider.server.stop(true)
  }
}, 60_000)

test("a third identical tool call is stopped before it runs, not after", async () => {
  const provider = repeatingProvider(3, "glob", { pattern: "*.md" })
  try {
    await using tmp = await tmpdir({
      git: true,
      config: {
        ...stressProviderConfig(`http://127.0.0.1:${provider.server.port}/v1`),
        // The doom-loop prompt is answered by policy so the run cannot hang.
        permission: { doom_loop: "deny" },
      },
    })
    await Bun.write(`${tmp.path}/README.md`, "# fixture\n")
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: "doom loop gate" })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          delegation: false,
          parts: [{ type: "text", text: "List the markdown files, repeatedly." }],
        }).catch(() => undefined)

        const messages = await Session.messages({ sessionID: session.id })
        const calls = messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool" && part.tool === "glob")
          .map((part) => (part.type === "tool" ? part.state : undefined))
        // The SDK starts execute() as soon as it parses a call; the guard used
        // to run from the stream position, after the tool had already run.
        expect(calls.map((state) => state?.status)).toEqual(["completed", "completed", "error"])
        const denied = calls[2]
        expect(denied?.status === "error" ? denied.error : "").toContain("doom_loop")
        expect(denied?.status === "error" ? "output" in denied : false).toBe(false)
      },
    })
  } finally {
    provider.server.stop(true)
  }
}, 60_000)
