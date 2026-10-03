import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@synsci/util/lazy"
import { UsageStats } from "@/session/usage-stats"
import { UsageQuery, UsageReport } from "@/session/usage-stats-schema"

export const UsageStatsRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "Get token usage, trends and project, session and model breakdowns for this server",
      operationId: "settings.usageStats.get",
      responses: {
        200: {
          description: "Usage statistics for the connected server",
          content: { "application/json": { schema: resolver(UsageReport) } },
        },
        400: { description: "Invalid date range or time zone" },
      },
    }),
    validator("query", UsageQuery.safeExtend({ refresh: z.enum(["0", "1"]).optional() })),
    async (c) => {
      const query = c.req.valid("query")
      c.header("Cache-Control", "no-store")
      return c.json(await UsageStats.report(query, query.refresh === "1"))
    },
  ),
)
