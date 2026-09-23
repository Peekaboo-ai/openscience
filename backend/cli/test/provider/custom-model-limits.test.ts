import { expect, test } from "bun:test"
import { CustomModelLimits } from "../../src/provider/custom-model-limits"
import { ModelsDev } from "../../src/provider/models"

test("reviewed models resolve exact capacities without guessing aliases", () => {
  for (const id of ["gpt-5.6-terra", "openai/gpt-5.6-sol"]) {
    expect(CustomModelLimits.defaults(id, {})).toEqual({
      context: 1_050_000,
      input: 922_000,
      output: 128_000,
      mode: "auto",
      source: "catalog",
    })
  }
  expect(CustomModelLimits.defaults("private/gpt-5.6-terra-special", {})).toEqual({
    context: 128_000,
    output: 32_000,
    mode: "auto",
    source: "fallback",
  })
})

test("native catalog matches exact IDs and keeps model-specific input caps", () => {
  const model = (context: number) =>
    ModelsDev.Model.parse({
      id: "fixture",
      name: "Fixture",
      release_date: "",
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: true,
      options: {},
      limit: { context, output: 2048, input: context - 2048 },
    })
  const catalog = {
    openrouter: { id: "openrouter", name: "Router", env: [], models: { fixture: model(8192) } },
    native: { id: "native", name: "Native", env: [], models: { fixture: model(16384) } },
  }
  expect(CustomModelLimits.defaults("fixture", catalog)).toMatchObject({ context: 16384, input: 14336 })
  expect(CustomModelLimits.defaults("openrouter/fixture", catalog)).toMatchObject({ context: 8192 })
})

test("endpoint capacities override catalog and missing fields use catalog defaults", () => {
  expect(
    CustomModelLimits.discovered(
      "gpt-5.6-terra",
      {
        context_length: 64_000,
        top_provider: { max_completion_tokens: 8_000, max_prompt_tokens: 56_000 },
      },
      {},
    ),
  ).toEqual({ context: 64_000, output: 8_000, input: 56_000, source: "endpoint", mode: "auto" })
  expect(CustomModelLimits.discovered("gpt-5.6-terra", { max_output_tokens: 16_000 }, {})).toMatchObject({
    context: 1_050_000,
    input: 922_000,
    output: 16_000,
    source: "endpoint",
  })
  expect(CustomModelLimits.discovered("unknown", { limits: { context: 4096, output: 8192 } }, {})).toMatchObject({
    context: 4096,
    output: 4096,
    source: "endpoint",
  })
  for (const value of [null, {}, { context_length: 1 }, { context_length: -1, max_output_tokens: "invalid" }]) {
    expect(CustomModelLimits.discovered("unknown", value, {}).source).toBe("fallback")
  }
})

test("legacy fixed defaults migrate while explicit limits remain stable", () => {
  const old = { context: 32768, output: 8192 }
  expect(CustomModelLimits.configured("gpt-5.6-terra", old, undefined, {}).context).toBe(1_050_000)
  expect(CustomModelLimits.configured("gpt-5.6-terra", old, { mode: "manual" }, {})).toEqual({
    ...old,
    mode: "manual",
    source: "manual",
  })
  const custom = { context: 65536, input: 60000, output: 4096 }
  expect(CustomModelLimits.configured("gpt-5.6-terra", custom, undefined, {})).toEqual({
    ...custom,
    mode: "manual",
    source: "manual",
  })
  expect(CustomModelLimits.configured("gpt-5.6-terra", custom, { mode: "auto", source: "endpoint" }, {})).toEqual({
    ...custom,
    mode: "auto",
    source: "endpoint",
  })
})

test("token constraints reject invalid context and caps beyond capacity", () => {
  for (const bounds of [
    { context: 512, output: 256 },
    { context: 1024, output: 2048 },
    { context: 2048, output: 256, input: 4096 },
    { context: Infinity, output: 1 },
  ])
    expect(CustomModelLimits.Limit.safeParse(bounds).success).toBe(false)
  expect(CustomModelLimits.configured("gpt-5.6-terra", { context: 0, output: 0 }, { mode: "manual" }, {}).context).toBe(
    1_050_000,
  )
})
