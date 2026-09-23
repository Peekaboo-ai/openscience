import { expect, test } from "bun:test"
import { createTimelineController, type Snapshot } from "./controller"
import { page } from "./fixtures"

test("timeline publishes actions before a slow workbench and preserves them during refresh", async () => {
  const delayed = Promise.withResolvers<Response>()
  let workbenches = 0
  let failed = false
  const states: Snapshot[] = []
  const controller = createTimelineController(
    "ses_a",
    async (path) => {
      if (path.endsWith("/workbench")) {
        workbenches++
        return delayed.promise
      }
      return failed ? new Response(null, { status: 503 }) : Response.json(page(["msg_a"]))
    },
    (state) => states.push(state),
  )
  try {
    await controller.refresh()
    expect(states.at(-1)?.entries[0]?.id).toBe("msg_a")
    expect(states.at(-1)?.loading).toBe(false)
    await controller.refresh(true)
    expect(workbenches).toBe(1)
    expect(states.slice(2).every((state) => !state.loading)).toBe(true)
    failed = true
    await controller.refresh()
    expect(states.at(-1)?.entries[0]?.id).toBe("msg_a")
    expect(states.at(-1)?.error).toContain("503")
    controller.dispose()
    const count = states.length
    delayed.resolve(Response.json({ sessionID: "ses_a" }))
    await Bun.sleep(0)
    expect(states).toHaveLength(count)
  } finally {
    controller.dispose()
  }
})
