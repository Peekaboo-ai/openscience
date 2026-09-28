import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { RuntimeRuns } from "../../src/runtime/runs"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { ActionTimeline } from "../../src/session/action-timeline"
import { tmpdir } from "../fixture/fixture"

test("warmup cannot resurrect a terminal runtime receipt through an unfinished transcript", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    async fn() {
      const session = await Session.create({})
      const accepted = await RuntimeRuns.admit({
        sessionID: session.id,
        requestID: "warmup",
        message: "research",
        effort: "normal",
      })
      await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "assistant",
        time: { created: Date.now() },
        parentID: accepted.run.messageID,
        agent: "research",
        mode: "research",
        modelID: "fixture",
        providerID: "fixture",
        path: { cwd: Instance.directory, root: Instance.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      await RuntimeRuns.cancel(session.id, accepted.run.runID)
      expect(await SessionPrompt.resumeInterrupted()).toEqual([])
      expect(SessionPrompt.activeController(session.id)).toBeUndefined()
      expect((await RuntimeRuns.get(session.id, accepted.run.runID)).state).toBe("cancelled")
      expect((await ActionTimeline.get(session.id)).entries[0]?.status).toBe("interrupted")
      expect((await Session.messages({ sessionID: session.id })).length).toBe(1)
    },
  })
})
