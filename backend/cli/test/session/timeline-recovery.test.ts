import { expect, test } from "bun:test"
import { literalAssignments, replayPlan } from "../../src/session/timeline-replay"
import { TimelineRecovery } from "../../src/session/timeline-recovery"
import { TimelineWorkbench } from "../../src/session/timeline-workbench"
import { TimelineBranches } from "../../src/session/timeline-branches"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { KernelRuntime } from "../../src/science/kernel/registry"
import type { ExecutionRecord } from "../../src/science/execution/history"
import { Storage } from "../../src/storage/storage"
import { tmpdir, trustProject, fullAccessExecution } from "../fixture/fixture"
import "../../src/tool/notebook"

test("replay compiler accepts literal state and excludes calls, side effects, redactions and resource amplification", () => {
  for (const code of ["x = 42", "name = 'hello'", "x = [1, 2, 3]\ny = {'a': True}"])
    expect(literalAssignments(code, "python")).toBe(true)
  for (const code of [
    "import os",
    "x = open('output', 'w').write('bad')",
    "x = eval('1')",
    "x = 2 ** 99999999",
    "x = [0] * 99999999",
    "x = f'{secret()}'",
    "x = __import__('os')",
    "x = y + 1",
    "x = '[REDACTED]'",
    "x = (lambda: 1)()",
    "x = 0\nos.remove('a')",
  ])
    expect(literalAssignments(code, "python")).toBe(false)
  expect(literalAssignments("x <- 42", "r")).toBe(true)
  expect(literalAssignments("x <- system('anything')", "r")).toBe(false)
  expect(literalAssignments("x <- 1:99999999", "r")).toBe(false)
})

function execution(id: string, code: string, generation = 1): ExecutionRecord {
  const missing = { status: "unavailable", reason: "not_captured" } as const
  return {
    id,
    session_id: "ses_fixture",
    sequence: Number(id),
    status: "succeeded",
    language: "python",
    code: { status: "available", value: code },
    environment: {
      name: { status: "available", value: "python" },
      interpreter: missing,
      kernel_id: { status: "available", value: "kernel" },
      incarnation: { status: "available", value: generation },
      restart_boundary: false,
    },
    timing: { created_at: missing, started_at: missing, completed_at: missing, duration_ms: missing },
    result: { summary: "", stdout: "", stderr: "", error: "", output_count: 0 },
    resources: missing,
    files: [],
    artifacts: [],
    provenance_id: null,
  }
}

test("later unknown mutations taint earlier state and old generations never replay", () => {
  const plan = replayPlan([
    execution("1", "x = 1"),
    execution("2", "mutate(x)"),
    execution("3", "y = 2"),
    execution("4", "z = 3", 2),
  ])
  expect(plan.map((step) => step.policy)).toEqual(["manual", "manual", "manual", "safe"])
  const current = replayPlan([execution("1", "x = 1"), execution("2", "mutate(x)"), execution("3", "y = 2")])
  expect(current.map((step) => step.policy)).toEqual(["manual", "manual", "safe"])
})

test("checkpoint recovery replays real Python state into a separate usable kernel and records lineage", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await using access = await fullAccessExecution()
      await trustProject()
      const session = await Session.create({ title: "Recovery integration" })
      const identity = { projectID: Instance.project.id, sessionID: session.id, name: "python", language: "python" }
      const targets: string[] = []
      try {
        expect((await KernelRuntime.execute(identity, "answer = 42\nlabel = 'recovered'", { timeout: 60000 })).ok).toBe(
          true,
        )
        const checkpoint = await TimelineWorkbench.checkpoint(session.id)
        const plan = await TimelineRecovery.plan(session.id, checkpoint.id)
        expect(plan.safe).toBe(1)
        expect(plan.manual).toBe(0)
        expect(JSON.stringify(plan)).not.toContain("answer =")
        const sourceGeneration = KernelRuntime.status(identity).incarnation
        const receipt = await TimelineRecovery.start(session.id, checkpoint.id)
        const deadline = Date.now() + 45000
        let result = receipt
        while (result.status === "running" && Date.now() < deadline) {
          await Bun.sleep(100)
          result = (await TimelineRecovery.list(session.id)).find((run) => run.id === receipt.id)!
        }
        if (result.targetID) targets.push(result.targetID)
        expect(result.status).toBe("completed")
        expect(result.completed).toBe(1)
        expect(result.targetID).not.toBe(session.id)
        expect(KernelRuntime.status(identity).incarnation).toBe(sourceGeneration)
        const restored = await KernelRuntime.execute(
          { ...identity, sessionID: result.targetID! },
          "print(answer, label)",
        )
        expect(restored.stdout).toContain("42 recovered")
        expect(await TimelineBranches.list(session.id)).toContainEqual(
          expect.objectContaining({ sessionID: result.targetID, sourceID: session.id, checkpointID: checkpoint.id }),
        )
        expect((await KernelRuntime.execute(identity, "print(answer)")).stdout).toContain("42")
      } finally {
        for (const id of [session.id, ...targets]) {
          await KernelRuntime.releaseSession(id)
          await Session.remove(id)
        }
      }
    },
  })
}, 120000)

test("abandoned recovery is interrupted and child controls enforce parent ownership", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const unrelated = await Session.create({})
      await Storage.write(["timeline_recovery", parent.id, "fixture"], {
        id: "fixture",
        checkpointID: "checkpoint",
        status: "running",
        completed: 0,
        total: 1,
        manual: 0,
        createdAt: 1,
        updatedAt: 1,
        owner: { pid: process.pid, identity: "wrong-process-identity" },
      })
      expect((await TimelineRecovery.list(parent.id))[0].status).toBe("interrupted")
      await expect(TimelineBranches.child(parent.id, unrelated.id, "stop")).rejects.toThrow("does not belong")
      await Session.remove(parent.id)
      await Session.remove(unrelated.id)
    },
  })
})
