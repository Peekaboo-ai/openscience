export const providerID = "custom-model-switch-review"
const names = { "gpt-6.1-sol": "GPT-6.1 Sol", "gpt-6-astra": "GPT-6 Astra", "claude-opus-5": "Claude Opus 5" }
export const provider = {
  id: providerID,
  name: "Research Gateway",
  source: "config",
  env: [],
  options: { customConnection: true },
  models: Object.fromEntries(
    Object.entries(names).map(([id, name]) => [
      id,
      {
        id,
        name,
        providerID,
        api: { id, url: "https://example.test/v1", npm: "@ai-sdk/openai" },
        capabilities: {
          temperature: false,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true },
          output: { text: true },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 128000, output: 4096 },
        options: {},
        headers: {},
        variants: {},
        status: "active",
        release_date: "2026-01-01",
      },
    ]),
  ),
}
