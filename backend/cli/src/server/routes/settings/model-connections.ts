import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@synsci/util/lazy"
import { CustomConnections } from "../../../provider/custom-connections"

const response = (schema: z.ZodType) => ({
  200: { description: "Success", content: { "application/json": { schema: resolver(schema) } } },
  400: {
    description: "Connection error",
    content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
  },
})
const models = z.object({ baseURL: z.string(), models: z.array(z.string()), limits: CustomConnections.Limits })

async function handle<T>(c: Context, action: () => Promise<T>) {
  try {
    return c.json(await action())
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof z.ZodError
            ? error.issues[0].message
            : error instanceof Error
              ? error.message
              : "Connection request failed.",
      },
      400,
    )
  }
}

export const ModelConnectionsRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        operationId: "modelConnections.list",
        summary: "List custom model connections",
        responses: response(z.object({ connections: z.array(CustomConnections.Connection) })),
      }),
      (c) => handle(c, async () => ({ connections: await CustomConnections.list() })),
    )
    .post(
      "/limits",
      describeRoute({
        operationId: "modelConnections.limits",
        summary: "Resolve per-model token limits",
        responses: response(z.object({ limits: CustomConnections.Limits })),
      }),
      validator("json", CustomConnections.Selection),
      (c) => handle(c, async () => ({ limits: await CustomConnections.limits(c.req.valid("json").models) })),
    )
    .post(
      "/models",
      describeRoute({
        operationId: "modelConnections.discover",
        summary: "Discover models using the selected API protocol",
        responses: response(models),
      }),
      validator("json", CustomConnections.Endpoint),
      (c) => handle(c, () => CustomConnections.discover(c.req.valid("json"))),
    )
    .post(
      "/",
      describeRoute({
        operationId: "modelConnections.save",
        summary: "Save a custom connection and its selected models",
        responses: response(CustomConnections.Connection),
      }),
      validator("json", CustomConnections.Input),
      (c) => handle(c, () => CustomConnections.save(c.req.valid("json"))),
    )
    .delete(
      "/:id",
      describeRoute({
        operationId: "modelConnections.remove",
        summary: "Remove a custom connection and its key",
        responses: response(z.object({ removed: z.boolean() })),
      }),
      validator("param", z.object({ id: z.string() })),
      (c) => handle(c, () => CustomConnections.remove(c.req.valid("param").id)),
    ),
)
