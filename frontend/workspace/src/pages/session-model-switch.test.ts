import { describe, expect, test } from "bun:test"
import {
  modelSwitchLabels,
  pendingModelSwitch,
  rememberModelSwitch,
  sessionModelSwitches,
  type ModelSwitchDrafts,
} from "./session-model-switch"

const sol = { providerID: "gateway", modelID: "gpt-6.1-sol" }
const astra = { providerID: "gateway", modelID: "gpt-6-astra" }
const opus = { providerID: "anthropic", modelID: "claude-opus-5" }
const first = { id: "msg_1", model: sol }

describe("conversation model changes", () => {
  test("does not announce an initial choice or repeated use of the same model", () => {
    expect(sessionModelSwitches([])).toEqual({ before: {}, last: undefined })
    expect(sessionModelSwitches([first]).before).toEqual({})
    expect(sessionModelSwitches([first, { id: "msg_2", model: { ...sol } }]).before).toEqual({})
  })

  test("places a change before the first message that uses each new model", () => {
    const turns = [first, { id: "msg_2", model: astra }, { id: "msg_3", model: astra }, { id: "msg_4", model: sol }]
    const history = sessionModelSwitches(turns)
    expect(history.before).toEqual({ msg_2: { from: sol, to: astra }, msg_4: { from: astra, to: sol } })
    expect(history.last).toEqual(turns[3])
    expect(sessionModelSwitches(JSON.parse(JSON.stringify(turns)))).toEqual(history)
  })

  test("does not invent a change before the first loaded turn; loading older turns restores it", () => {
    const latest = { id: "msg_2", model: astra }
    expect(sessionModelSwitches([latest]).before).toEqual({})
    expect(sessionModelSwitches([first, latest]).before[latest.id]).toEqual({ from: sol, to: astra })
  })

  test("records a provider change even if the model ID stays the same", () => {
    const moved = { ...sol, providerID: "other-gateway" }
    expect(sessionModelSwitches([first, { id: "msg_2", model: moved }]).before.msg_2).toEqual({ from: sol, to: moved })
  })

  test("coalesces choices before sending and removes a change back to the previous model", () => {
    const next = rememberModelSwitch({}, "session", first, astra)
    expect(pendingModelSwitch(first, next.session, astra)).toEqual({ from: sol, to: astra })
    const final = rememberModelSwitch(next, "session", first, opus)
    expect(pendingModelSwitch(first, final.session, opus)).toEqual({ from: sol, to: opus })
    expect(Object.keys(final)).toEqual(["session"])
    expect(rememberModelSwitch(final, "session", first, sol)).toEqual({})
  })

  test("keeps new conversations free of change notices", () => {
    expect(rememberModelSwitch({}, "new", undefined, astra)).toEqual({})
    expect(pendingModelSwitch(undefined, { after: "msg_1", to: astra }, astra)).toBeUndefined()
  })

  test("restores an unsent choice after refresh and consumes it when a new turn exists", () => {
    const stored = JSON.parse(JSON.stringify(rememberModelSwitch({}, "session", first, astra)))
    expect(pendingModelSwitch(first, stored.session, astra)).toEqual({ from: sol, to: astra })
    const second = { id: "msg_2", model: astra }
    expect(pendingModelSwitch(second, stored.session, astra)).toBeUndefined()
    expect(sessionModelSwitches([first, second]).before.msg_2).toEqual({ from: sol, to: astra })
  })

  test("isolates sessions and ignores a current selection changed elsewhere", () => {
    const drafts = rememberModelSwitch(rememberModelSwitch({}, "local", first, astra), "remote", first, opus)
    expect(pendingModelSwitch(first, drafts.local, opus)).toBeUndefined()
    expect(pendingModelSwitch(first, drafts.remote, opus)).toEqual({ from: sol, to: opus })
    expect(pendingModelSwitch(first, drafts.local, undefined)).toBeUndefined()
  })

  test("bounds saved drafts and keeps the most recently changed session", () => {
    const drafts: ModelSwitchDrafts = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`session_${i}`, { after: first.id, to: astra }]),
    )
    const updated = rememberModelSwitch(drafts, "session_0", first, opus)
    const next = rememberModelSwitch(updated, "new-session", first, astra)
    expect(Object.keys(next)).toHaveLength(40)
    expect(next.session_1).toBeUndefined()
    expect(next.session_0?.to).toEqual(opus)
    expect(drafts.session_0?.to).toEqual(astra)
  })

  test("uses readable catalog names and distinguishes same-name providers", () => {
    const providers: Parameters<typeof modelSwitchLabels>[1] = [
      {
        id: "gateway",
        name: "Research Gateway",
        models: { "gpt-6.1-sol": { name: "GPT-6.1 Sol" }, "gpt-6-astra": { name: "GPT-6 Astra" } },
      },
      { id: "other", name: "Other Gateway", models: { "gpt-6.1-sol": { name: "GPT-6.1 Sol" } } },
    ]
    expect(modelSwitchLabels({ from: sol, to: astra }, providers)).toMatchObject({
      from: "GPT-6.1 Sol",
      to: "GPT-6 Astra",
    })
    expect(modelSwitchLabels({ from: sol, to: { ...sol, providerID: "other" } }, providers)).toMatchObject({
      from: "GPT-6.1 Sol (Research Gateway)",
      to: "GPT-6.1 Sol (Other Gateway)",
    })
    expect(modelSwitchLabels({ from: sol, to: astra }, [])).toMatchObject({ from: sol.modelID, to: astra.modelID })
  })
})
