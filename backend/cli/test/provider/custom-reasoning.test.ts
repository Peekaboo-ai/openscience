import { expect, test } from "bun:test"
import { customReasoning } from "../../src/provider/custom-reasoning"
import type { Provider } from "../../src/provider/provider"

test("existing custom models recover only their reviewed effort ladder", () => {
  expect(customReasoning("gpt-5.6-terra", []).reasoningOptions[0].values).toEqual([
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ])
  expect(customReasoning("openai/gpt-6-astra", []).reasoningOptions[0].values).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ])
  expect(customReasoning("deepseek-v4-pro", []).reasoningOptions).toEqual([])
})

test("unknown aliases and models without an effort dial do not get invented choices", () => {
  for (const id of ["my-gpt-5.6-terra", "unknown-thinking", "minimax-m3"]) {
    expect(customReasoning(id, []).reasoningOptions).toEqual([])
  }
})

test("custom effort choices must also be representable by the selected protocol", () => {
  expect(customReasoning("gpt-5.6-sol", [], "@ai-sdk/anthropic").reasoningOptions[0].values).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ])
  expect(customReasoning("gpt-5.6-sol", [], "@ai-sdk/openai").reasoningOptions[0].values).toContain("none")
  expect(customReasoning("unknown", [], "@ai-sdk/anthropic").reasoningOptions).toEqual([])
})

test("catalog models retain their exact effort choices and supported default", () => {
  const source: Provider.Model = {
    id: "catalog-reasoner",
    providerID: "vendor",
    api: { id: "catalog-reasoner", npm: "@ai-sdk/openai-compatible", url: "https://example.test/v1" },
    name: "Catalog reasoner",
    capabilities: {
      attachment: false,
      reasoning: true,
      temperature: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    reasoningOptions: [{ type: "effort", values: ["low", "high", "high"], default: "low" }],
  }
  expect(customReasoning("vendor/catalog-reasoner", [source])).toEqual({
    reasoning: true,
    reasoningOptions: [{ type: "effort", values: ["low", "high"], default: "low" }],
  })
  expect(customReasoning("renamed-catalog-reasoner", [source]).reasoningOptions).toEqual([])
  const interleaved = { field: "reasoning_content" as const }
  const result = customReasoning("vendor/catalog-reasoner", [
    { ...source, capabilities: { ...source.capabilities, interleaved } },
  ])
  expect(result.interleaved).toEqual(interleaved)
})
