import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Session } from "../../session"
import { SessionStatus } from "../../session/status"
import { ActionTimeline } from "../../session/action-timeline"
import { TimelineWorkbench } from "../../session/timeline-workbench"
import { errors } from "../error"
import { Identifier } from "../../id/id"
import { TimelineBranches } from "../../session/timeline-branches"
import { TimelineRecovery } from "../../session/timeline-recovery"

const param = z.object({ sessionID: Identifier.schema("session") })

export function ActionTimelineRoutes() {
  return new Hono()
    .post(
      "/:sessionID/action-timeline/fork",
      describeRoute({
        summary: "Create a timeline branch",
        operationId: "session.timelineFork",
        responses: {
          200: {
            description: "Branch session identifier",
            content: { "application/json": { schema: resolver(z.object({ sessionID: z.string() })) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", param),
      validator(
        "json",
        z.object({ messageID: Identifier.schema("message").optional(), checkpointID: z.string().uuid().optional() }),
      ),
      async (c) => {
        const id = c.req.valid("param").sessionID
        const input = c.req.valid("json")
        const result = input.checkpointID
          ? await TimelineRecovery.fork(id, input.checkpointID)
          : await TimelineBranches.fork(id, input.messageID)
        return c.json({ sessionID: result.id })
      },
    )
    .get(
      "/:sessionID/action-timeline/revert-preview",
      describeRoute({
        summary: "Preview conversation undo",
        operationId: "session.timelineRevertPreview",
        responses: {
          200: {
            description: "Affected messages and tracked files",
            content: { "application/json": { schema: resolver(TimelineBranches.Preview) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", param),
      validator("query", z.object({ messageID: Identifier.schema("message") })),
      async (c) =>
        c.json(await TimelineBranches.preview(c.req.valid("param").sessionID, c.req.valid("query").messageID)),
    )
    .get(
      "/:sessionID/action-timeline/recovery/:checkpointID",
      describeRoute({
        summary: "Preview safe checkpoint replay",
        operationId: "session.timelineRecoveryPlan",
        responses: {
          200: {
            description: "Replay and manual steps",
            content: { "application/json": { schema: resolver(TimelineRecovery.Plan) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", param.extend({ checkpointID: z.string().uuid() })),
      async (c) =>
        c.json(await TimelineRecovery.plan(c.req.valid("param").sessionID, c.req.valid("param").checkpointID)),
    )
    .post(
      "/:sessionID/action-timeline/recovery/:checkpointID",
      describeRoute({
        summary: "Recover a checkpoint into a fresh branch",
        operationId: "session.timelineRecover",
        responses: {
          202: {
            description: "Durable recovery receipt",
            content: { "application/json": { schema: resolver(TimelineRecovery.Run) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", param.extend({ checkpointID: z.string().uuid() })),
      async (c) =>
        c.json(await TimelineRecovery.start(c.req.valid("param").sessionID, c.req.valid("param").checkpointID), 202),
    )
    .post(
      "/:sessionID/action-timeline/child/:childID",
      describeRoute({
        summary: "Stop or steer an owned child agent",
        operationId: "session.timelineChild",
        responses: {
          200: {
            description: "Applied child control",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", param.extend({ childID: Identifier.schema("session") })),
      validator(
        "json",
        z.discriminatedUnion("operation", [
          z.object({ operation: z.literal("stop") }),
          z.object({ operation: z.literal("steer"), text: z.string().trim().min(1).max(16000) }),
        ]),
      ),
      async (c) => {
        const input = c.req.valid("json")
        await TimelineBranches.child(
          c.req.valid("param").sessionID,
          c.req.valid("param").childID,
          input.operation,
          input.operation === "steer" ? input.text : undefined,
        )
        return c.json({ ok: true })
      },
    )
    .get(
      "/:sessionID/action-timeline",
      describeRoute({
        summary: "Read the durable action timeline",
        operationId: "session.actionTimeline",
        description:
          "Safe projection of persisted actions. Cursors page whole messages (1–200), newest first by default; entries within a page are chronological. Raw input, output, reasoning and provider state are excluded.",
        responses: {
          200: {
            description: "Action timeline page",
            content: { "application/json": { schema: resolver(ActionTimeline.Page) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", param),
      validator("query", ActionTimeline.Query),
      async (c) => c.json(await ActionTimeline.get(c.req.valid("param").sessionID, c.req.valid("query"))),
    )
    .get(
      "/:sessionID/action-timeline/workbench",
      describeRoute({
        summary: "Read timeline runtime and research state",
        operationId: "session.timelineWorkbench",
        responses: {
          200: {
            description: "Safe workbench projection",
            content: { "application/json": { schema: resolver(TimelineWorkbench.Info) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", param),
      async (c) => c.json(await TimelineWorkbench.get(c.req.valid("param").sessionID)),
    )
    .post(
      "/:sessionID/action-timeline/checkpoint",
      describeRoute({
        summary: "Save a research recovery checkpoint",
        operationId: "session.timelineCheckpoint",
        description:
          "Saves the native research handoff file and its durable timeline reference. Does not snapshot interpreter memory.",
        responses: {
          200: {
            description: "Saved checkpoint",
            content: { "application/json": { schema: resolver(TimelineWorkbench.Checkpoint) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", param),
      async (c) => {
        const id = c.req.valid("param").sessionID
        await Session.assertDirectory(id)
        if (SessionStatus.get(id).type !== "idle")
          return c.json(
            { name: "BusyError", data: { message: "Wait for the session to become idle before saving a checkpoint." } },
            409,
          )
        return c.json(await TimelineWorkbench.checkpoint(id))
      },
    )
}
