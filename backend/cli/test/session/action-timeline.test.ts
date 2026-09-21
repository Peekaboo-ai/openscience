import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { ActionTimeline } from "../../src/session/action-timeline"
import { TimelineWorkbench } from "../../src/session/timeline-workbench"
import { TimelineRecovery } from "../../src/session/timeline-recovery"
import { TimelineBranches } from "../../src/session/timeline-branches"
import { ActionTimelineRoutes } from "../../src/server/routes/action-timeline"
import type { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

const tokens = { input: 30, output: 20, reasoning: 5, cache: { read: 10, write: 2 } }
function assistant(sessionID: string, id: string, completed = true): MessageV2.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 1000, ...(completed ? { completed: 1500 } : {}) },
    parentID: "msg_user",
    agent: "research",
    mode: "research",
    modelID: "model",
    providerID: "provider",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0.1,
    tokens,
    ...(completed ? { finish: "stop" } : {}),
  }
}

async function fixture(run: (sessionID: string) => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "Action timeline integration" })
      await run(session.id)
      await Session.remove(session.id)
    },
  })
}

describe("durable action timeline", () => {
  test("paginates by stable message cursor and refreshes tool outcomes without copying private data", () =>
    fixture(async (sessionID) => {
      for (const id of ["msg_001", "msg_002", "msg_003"]) await Session.updateMessage(assistant(sessionID, id))
      const part: MessageV2.ToolPart = {
        id: "prt_action",
        sessionID,
        messageID: "msg_003",
        type: "tool",
        callID: "call-private",
        tool: "python",
        state: {
          status: "running",
          input: { code: "SECRET_INPUT" },
          title: "SECRET_TITLE",
          time: { start: 1100 },
          metadata: { wire_state: "SECRET_WIRE" },
        },
      }
      await Session.updatePart(part)
      SessionStatus.set(sessionID, { type: "busy" })
      const latest = await ActionTimeline.get(sessionID, { limit: 2 })
      expect(latest.messageIDs).toEqual(["msg_002", "msg_003"])
      expect(latest.hasEarlier).toBe(true)
      expect(latest.entries.at(-1)).toMatchObject({
        id: "prt_action",
        status: "running",
        kind: "kernel",
        language: "python",
      })
      const earlier = await ActionTimeline.get(sessionID, { before: latest.first!, limit: 2 })
      expect(earlier.messageIDs).toEqual(["msg_001"])
      expect(earlier.hasEarlier).toBe(false)
      const forward = await ActionTimeline.get(sessionID, { after: "msg_001", limit: 1 })
      expect(forward.messageIDs).toEqual(["msg_002"])
      expect(forward.hasMore).toBe(true)
      await Session.updatePart({
        ...part,
        state: {
          status: "completed",
          input: part.state.input,
          output: "SECRET_OUTPUT",
          title: "SECRET_TITLE",
          metadata: { ok: false },
          time: { start: 1100, end: 1400 },
        },
      })
      const updated = ActionTimeline.Page.parse(await ActionTimeline.get(sessionID))
      expect(updated.entries.at(-1)).toMatchObject({ id: "prt_action", status: "error", completedAt: 1400 })
      expect(JSON.stringify(updated)).not.toMatch(/SECRET_|wire_state|call-private|canonical_arguments/)
    }))

  test.each(["partial", "error", "cancelled"])("projects %s independently of transport completion", (outcome) =>
    fixture(async (sessionID) => {
      await Session.updateMessage(assistant(sessionID, "msg_a"))
      await Session.updatePart({
        id: "prt_a",
        sessionID,
        messageID: "msg_a",
        type: "tool",
        callID: "call",
        tool: "task",
        state: {
          status: "completed",
          input: {},
          output: "private",
          title: "private",
          time: { start: 1100, end: 1200 },
          metadata: outcome === "cancelled" ? { cancelled: true } : { outcome },
        },
      })
      expect((await ActionTimeline.get(sessionID)).entries.at(-1)?.status).toBe(outcome)
    }),
  )

  test("does not pretend stale persisted work is still running after a restart", () =>
    fixture(async (sessionID) => {
      await Session.updateMessage(assistant(sessionID, "msg_live", false))
      expect((await ActionTimeline.get(sessionID)).entries[0].status).toBe("interrupted")
      SessionStatus.set(sessionID, { type: "busy" })
      expect((await ActionTimeline.get(sessionID)).entries[0].status).toBe("running")
    }))

  test("validates cursors and excludes reverted messages", () =>
    fixture(async (sessionID) => {
      const routes = ActionTimelineRoutes()
      for (const query of ["limit=0", "limit=201", "limit=1.5", "before=msg_a&after=msg_b", "before=invalid"]) {
        expect((await routes.request(`/${sessionID}/action-timeline?${query}`)).status).toBe(400)
      }
      await Session.updateMessage(assistant(sessionID, "msg_001"))
      await Session.updateMessage(assistant(sessionID, "msg_002"))
      await Session.update(sessionID, (draft) => {
        draft.revert = { messageID: "msg_002" }
      })
      const response = await routes.request(`/${sessionID}/action-timeline`)
      expect(response.status).toBe(200)
      expect(ActionTimeline.Page.parse(await response.json()).messageIDs).toEqual(["msg_001"])
    }))

  test("rejects reading another project's session", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const id = await Instance.provide({ directory: first.path, fn: async () => (await Session.create({})).id })
    await Instance.provide({
      directory: second.path,
      fn: async () => {
        await expect(ActionTimeline.get(id)).rejects.toThrow()
        await expect(TimelineWorkbench.get(id)).rejects.toThrow()
      },
    })
  })

  test("workbench reports real capabilities and persists a native checkpoint", () =>
    fixture(async (sessionID) => {
      const initial = await TimelineWorkbench.get(sessionID)
      expect(initial.capabilities.kernelRestore).toBe(true)
      expect(initial.context.input).toBeNull()
      expect(initial.kernels).toEqual([])
      const record = await TimelineWorkbench.checkpoint(sessionID)
      expect(await Bun.file(`${Instance.worktree}/${record.path}`).exists()).toBe(true)
      const next = TimelineWorkbench.Info.parse(await TimelineWorkbench.get(sessionID))
      expect(next.checkpoints.map((item) => item.id)).toContain(record.id)
      SessionStatus.set(sessionID, { type: "busy" })
      expect(
        (await ActionTimelineRoutes().request(`/${sessionID}/action-timeline/checkpoint`, { method: "POST" })).status,
      ).toBe(409)
    }))

  test("checkpoint forks include the saved boundary but exclude later messages and preview undo", () =>
    fixture(async (sessionID) => {
      await Session.updateMessage(assistant(sessionID, "msg_001"))
      const checkpoint = await TimelineWorkbench.checkpoint(sessionID)
      await Session.updateMessage(assistant(sessionID, "msg_002"))
      const preview = await TimelineBranches.preview(sessionID, "msg_002")
      expect(preview.messages).toBe(1)
      expect(preview.actions).toBe(1)
      await expect(TimelineBranches.preview(sessionID, "msg_missing")).rejects.toThrow()
      const fork = await TimelineRecovery.fork(sessionID, checkpoint.id)
      expect((await Session.messages({ sessionID: fork.id })).length).toBe(1)
      expect((await Session.messages({ sessionID })).length).toBe(2)
      expect(fork.parentID).toBeUndefined()
      expect((await TimelineBranches.list(fork.id))[0]).toMatchObject({
        sourceID: sessionID,
        sessionID: fork.id,
        checkpointID: checkpoint.id,
      })
      const response = await ActionTimelineRoutes().request(`/${sessionID}/action-timeline/recovery/${checkpoint.id}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ checkpointID: checkpoint.id, safe: 0, manual: 0 })
      await Session.remove(fork.id)
    }))
})
