import { expect, test } from "bun:test"
import { createTimelineController, type Snapshot, type Transport } from "./controller"
import { page } from "./fixtures"

const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
const request =
  (load: Transport): Transport =>
  (path, init, query) =>
    path.endsWith("workbench") ? Promise.resolve(response({ sessionID: "ses_a" })) : load(path, init, query)

test("fills a burst of new pages without losing loaded history and removes reverted actions", async () => {
  let cycle = 0
  const snapshots: Snapshot[] = []
  const controller = createTimelineController(
    "ses_a",
    request(async (_path, _init, query) => {
      if (cycle === 0) return response(page(["msg_1", "msg_2"]))
      if (cycle === 2) return response(page(["msg_1"]))
      if (!query?.before) return response(page(["msg_5", "msg_6"], { hasEarlier: true }))
      if (query.before === "msg_5") return response(page(["msg_3", "msg_4"], { hasEarlier: true }))
      return response(page(["msg_1", "msg_2"]))
    }),
    (value) => snapshots.push(value),
  )
  await controller.refresh()
  cycle = 1
  await controller.refresh()
  expect(snapshots.at(-1)?.entries.map((entry) => entry.id)).toEqual([
    "msg_1",
    "msg_2",
    "msg_3",
    "msg_4",
    "msg_5",
    "msg_6",
  ])
  cycle = 2
  await controller.refresh()
  expect(snapshots.at(-1)?.entries.map((entry) => entry.id)).toEqual(["msg_1"])
  controller.dispose()
})

test("preserves data on network failure and rejects a mismatched session", async () => {
  let fail = false
  let mismatch = false
  let state: Snapshot | undefined
  const controller = createTimelineController(
    "ses_a",
    request(async () => {
      if (fail) throw new Error("offline")
      return response(page(["msg_1"], mismatch ? { sessionID: "ses_wrong" } : {}))
    }),
    (next) => {
      state = next
    },
  )
  await controller.refresh()
  fail = true
  await controller.refresh()
  expect(state?.entries).toHaveLength(1)
  expect(state?.error).toBe("offline")
  fail = false
  mismatch = true
  await controller.refresh()
  expect(state?.error).toContain("does not match")
  controller.dispose()
})

test("a late response after unmount cannot overwrite the next session", async () => {
  let finish: (value: Response) => void = () => {}
  const snapshots: Snapshot[] = []
  const controller = createTimelineController(
    "ses_a",
    request(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    ),
    (value) => snapshots.push(value),
  )
  const pending = controller.refresh()
  controller.dispose()
  const count = snapshots.length
  finish(response(page(["msg_late"])))
  await pending
  expect(snapshots).toHaveLength(count)
})

test("history pagination stops on a non-advancing cursor", async () => {
  let state: Snapshot | undefined
  const controller = createTimelineController(
    "ses_a",
    request(async () => response(page(["msg_2"], { hasEarlier: true }))),
    (value) => {
      state = value
    },
  )
  await controller.refresh()
  await controller.earlier()
  expect(state?.error).toContain("cursor did not advance")
  controller.dispose()
})
