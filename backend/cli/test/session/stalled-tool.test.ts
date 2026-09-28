import { expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"
import type { MessageV2 } from "../../src/session/message-v2"

function completed(input: Record<string, unknown>, output: string, tool = "bash"): MessageV2.ToolPart {
  return {
    id: crypto.randomUUID(),
    callID: crypto.randomUUID(),
    messageID: "message",
    sessionID: "session",
    type: "tool",
    tool,
    state: { status: "completed", input, output, title: "probe", metadata: {}, time: { start: 1, end: 2 } },
  }
}

test("canonical arguments detect repetition despite reordered keys and different call IDs", () => {
  const parts = [
    completed({ command: "pwd", timeout: 10 }, "/work"),
    completed({ timeout: 10, command: "pwd" }, "/work"),
    completed({ command: "pwd", timeout: 10 }, "/work"),
  ]
  expect(SessionProcessor.isDoomLoop(parts, "bash", { timeout: 10, command: "pwd" })).toBe(true)
  expect(SessionProcessor.stalledTool(parts)).toBe("bash")
})

test("changed polling results, changed array arguments and incomplete calls are not stagnation", () => {
  expect(
    SessionProcessor.stalledTool([10, 10, 20].map((n) => completed({ command: "status" }, `${n}%`))),
  ).toBeUndefined()
  expect(
    SessionProcessor.stalledTool([
      completed({ args: [1, 2] }, "same"),
      completed({ args: [2, 1] }, "same"),
      completed({ args: [1, 2] }, "same"),
    ]),
  ).toBeUndefined()
  const unfinished = completed({ command: "status" }, "same")
  unfinished.state = { status: "running", input: { command: "status" }, time: { start: 1 } }
  expect(
    SessionProcessor.stalledTool([
      completed({ command: "status" }, "same"),
      completed({ command: "status" }, "same"),
      unfinished,
    ]),
  ).toBeUndefined()
})

test("short alternating cycles trip only when all action results remain unchanged", () => {
  const cycle = () => [
    completed({ command: "locate" }, "missing"),
    completed({ url: "https://example.test" }, "timeout", "fetch"),
  ]
  expect(SessionProcessor.stalledTool([...cycle(), ...cycle()])).toBeUndefined()
  expect(SessionProcessor.stalledTool([...cycle(), ...cycle(), ...cycle()])).toBe("fetch")
  expect(
    SessionProcessor.stalledTool([...cycle(), ...cycle(), completed({ command: "locate" }, "/bin/R"), cycle()[1]]),
  ).toBeUndefined()
})

test("silent commands with changing file receipts are making progress", () => {
  const parts = [1, 2, 3].map((size) => {
    const part = completed({ command: "run-next-step" }, "")
    if (part.state.status === "completed")
      part.state.metadata.outputFiles = [{ path: "/work/result.csv", size, modified: size, change: "modified" }]
    return part
  })
  expect(SessionProcessor.stalledTool(parts)).toBeUndefined()
})

test("new external user epoch resets the persisted no-progress window", () => {
  const user = (id: string): MessageV2.WithParts => ({
    info: {
      id,
      sessionID: "session",
      role: "user",
      time: { created: 1 },
      agent: "research",
      effort: "normal",
      model: { providerID: "test", modelID: "test" },
      internal: { type: "prompt", epoch: id },
    },
    parts: [],
  })
  const assistant = (id: string, parentID: string, count: number): MessageV2.WithParts => ({
    info: {
      id,
      parentID,
      sessionID: "session",
      role: "assistant",
      time: { created: 1 },
      modelID: "test",
      providerID: "test",
      mode: "research",
      agent: "research",
      path: { cwd: "/work", root: "/work" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: Array.from({ length: count }, () => completed({ command: "pwd" }, "/work")),
  })
  const history = [
    user("user-1"),
    assistant("assistant-1", "user-1", 3),
    user("user-2"),
    assistant("assistant-2", "user-2", 1),
  ]
  expect(SessionProcessor.stalledTool(SessionProcessor.turnParts(history, "user-1"))).toBe("bash")
  expect(SessionProcessor.stalledTool(SessionProcessor.turnParts(history, "user-2"))).toBeUndefined()
})
