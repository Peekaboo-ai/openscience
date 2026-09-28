import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { RuntimeEvents } from "../../src/runtime/events"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

test("a slow observer cannot hold run acceptance or prevent a healthy observer from seeing ordered events", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    async fn() {
      const session = await Session.create({})
      const blocked = Promise.withResolvers<void>()
      const received: string[] = []
      const slow = RuntimeEvents.subscribe(session.id, () => blocked.promise)
      const healthy = RuntimeEvents.subscribe(session.id, (event) => {
        received.push(event.type)
      })
      try {
        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_slow_observer",
          acceptedAt: Date.now(),
          effort: "normal",
        })
        await RuntimeEvents.finish({ sessionID: session.id, runID: "run_slow_observer", messageID: "msg_done" })
        expect(received).toEqual(["runtime.accepted", "runtime.completed"])
        expect((await RuntimeEvents.replay(session.id)).events.map((event) => event.type)).toEqual(received)
      } finally {
        blocked.resolve()
        slow()
        healthy()
      }
    },
  })
})
