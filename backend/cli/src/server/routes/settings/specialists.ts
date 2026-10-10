import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@synsci/util/lazy"
import { Specialists, createSpecialists } from "../../../specialist"
import { SpecialistSchema } from "../../../specialist/schema"
import { SpecialistError } from "../../../specialist/repository"

const revision = z.object({ revision: z.number().int().nonnegative() })
const params = z.object({ name: SpecialistSchema.ID })
const output = (operation: string, summary: string, schema: z.ZodType = SpecialistSchema.Snapshot) =>
  describeRoute({
    summary,
    operationId: `settings.specialists.${operation}`,
    responses: {
      200: { description: summary, content: { "application/json": { schema: resolver(schema) } } },
      400: { description: "Invalid specialist or capabilities" },
      404: { description: "Specialist not found" },
      409: { description: "Conflicting revision or agent ID" },
    },
  })
async function reply(c: Context, action: () => Promise<unknown>) {
  try {
    return c.json(await action())
  } catch (error) {
    if (error instanceof SpecialistError) return c.json({ message: error.message }, error.status)
    throw error
  }
}
export function createSpecialistRoutes(service: ReturnType<typeof createSpecialists> = Specialists) {
  return new Hono()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store")
      await next()
    })
    .get("/", output("list", "List built-in and custom specialists"), (c) => reply(c, service.list))
    .get("/catalog", output("catalog", "List available specialist capabilities", SpecialistSchema.Catalog), (c) =>
      reply(c, service.catalog),
    )
    .post(
      "/",
      output("create", "Create a specialist"),
      validator("json", revision.extend({ profile: SpecialistSchema.Input }).strict()),
      (c) => {
        const input = c.req.valid("json")
        return reply(c, () => service.save(input.revision, input.profile))
      },
    )
    .put(
      "/:name",
      output("update", "Update a specialist"),
      validator("param", params),
      validator("json", revision.extend({ profile: SpecialistSchema.Input }).strict()),
      (c) => {
        const input = c.req.valid("json")
        return reply(c, () => service.save(input.revision, input.profile, c.req.valid("param").name))
      },
    )
    .patch(
      "/:name",
      output("toggle", "Enable or disable a specialist"),
      validator("param", params),
      validator("json", revision.extend({ enabled: z.boolean() }).strict()),
      (c) => {
        const input = c.req.valid("json")
        return reply(c, () => service.toggle(input.revision, c.req.valid("param").name, input.enabled))
      },
    )
    .delete(
      "/:name",
      output("remove", "Delete a custom specialist or restore a built-in specialist"),
      validator("param", params),
      validator("json", revision.strict()),
      (c) => reply(c, () => service.remove(c.req.valid("json").revision, c.req.valid("param").name)),
    )
}
export const SpecialistSettingsRoutes = lazy(createSpecialistRoutes)
