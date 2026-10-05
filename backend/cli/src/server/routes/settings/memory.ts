import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@synsci/util/lazy"
import { Memory, type createMemoryService } from "../../../memory"
import { MemorySchema } from "../../../memory/schema"
import { MemoryError } from "../../../memory/repository"
import { Storage } from "../../../storage/storage"
import { Log } from "../../../util/log"

const output = (operation: string, summary: string, schema: z.ZodType) =>
  describeRoute({
    summary,
    operationId: `settings.memory.${operation}`,
    responses: {
      200: { description: summary, content: { "application/json": { schema: resolver(schema) } } },
      400: { description: "Invalid memory or scope" },
      404: { description: "Scope or memory not found" },
      409: { description: "Memory was changed by another client or a title is duplicated" },
    },
  })
const params = z.object({ id: MemorySchema.ID })

async function reply<T>(c: Context, action: () => Promise<T>) {
  try {
    return c.json(await action())
  } catch (error) {
    if (error instanceof MemoryError) return c.json({ message: error.message }, error.status)
    if (error instanceof Storage.NotFoundError)
      return c.json({ message: "The selected project or session no longer exists" }, 404)
    Log.create({ service: "settings-memory" }).error("memory request failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return c.json(
      {
        message:
          "Memory could not be read or saved. Existing notes have been preserved. Check the server storage and retry.",
      },
      500,
    )
  }
}

export function createMemoryRoutes(memory: ReturnType<typeof createMemoryService> = Memory) {
  return new Hono()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store")
      await next()
    })
    .get("/", output("get", "Get saved memory for this server", MemorySchema.Store), (c) => reply(c, memory.read))
    .patch(
      "/",
      output("update", "Enable or pause automatic memory recall", MemorySchema.Store),
      validator("json", MemorySchema.Revision.extend({ enabled: z.boolean() }).strict()),
      (c) => {
        const input = c.req.valid("json")
        return reply(c, () => memory.setEnabled(input.revision, input.enabled))
      },
    )
    .get(
      "/catalog",
      output("catalog", "List memory projects and sessions", MemorySchema.Catalog),
      validator("query", z.object({ projectID: MemorySchema.ID.optional() })),
      (c) => reply(c, () => memory.catalog(c.req.valid("query").projectID)),
    )
    .get(
      "/preview",
      output("preview", "Preview the exact saved context for a project or session", MemorySchema.Preview),
      validator("query", MemorySchema.Target),
      (c) => reply(c, () => memory.preview(c.req.valid("query"))),
    )
    .post(
      "/notes",
      output("createNote", "Create a memory note", MemorySchema.Store),
      validator("json", MemorySchema.Revision.extend({ note: MemorySchema.NoteInput }).strict()),
      (c) => {
        const input = c.req.valid("json")
        return reply(c, () => memory.saveNote(input.revision, input.note))
      },
    )
    .put(
      "/notes/:id",
      output("updateNote", "Update a memory note", MemorySchema.Store),
      validator("param", params),
      validator("json", MemorySchema.Revision.extend({ note: MemorySchema.NoteInput }).strict()),
      (c) => {
        const input = c.req.valid("json")
        return reply(c, () => memory.saveNote(input.revision, input.note, c.req.valid("param").id))
      },
    )
    .post(
      "/notes/delete",
      output("deleteNotes", "Delete selected memory notes", MemorySchema.Store),
      validator(
        "json",
        MemorySchema.Revision.extend({ ids: MemorySchema.ID.array().min(1).max(MemorySchema.limits.notes) }).strict(),
      ),
      (c) => {
        const input = c.req.valid("json")
        return reply(c, () => memory.removeNotes(input.revision, input.ids))
      },
    )
    .post(
      "/categories",
      output("createCategory", "Create a memory category", MemorySchema.Store),
      validator("json", MemorySchema.Revision.extend({ category: MemorySchema.CategoryInput }).strict()),
      (c) => {
        const input = c.req.valid("json")
        return reply(c, () => memory.saveCategory(input.revision, input.category))
      },
    )
    .put(
      "/categories/:id",
      output("updateCategory", "Update a memory category", MemorySchema.Store),
      validator("param", params),
      validator("json", MemorySchema.Revision.extend({ category: MemorySchema.CategoryInput }).strict()),
      (c) => {
        const input = c.req.valid("json")
        return reply(c, () => memory.saveCategory(input.revision, input.category, c.req.valid("param").id))
      },
    )
    .delete(
      "/categories/:id",
      output("deleteCategory", "Delete an empty memory category", MemorySchema.Store),
      validator("param", params),
      validator("json", MemorySchema.Revision.strict()),
      (c) => reply(c, () => memory.removeCategory(c.req.valid("json").revision, c.req.valid("param").id)),
    )
}

export const MemorySettingsRoutes = lazy(() => createMemoryRoutes())
