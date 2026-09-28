import { expect, test } from "bun:test"
import { AdmissionGate, RuntimeAdmission } from "../../src/runtime/admission"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("admission preserves FIFO and releasing twice cannot release a successor", async () => {
  const gate = new AdmissionGate()
  const first = await gate.acquire("session")
  const order: number[] = []
  const second = gate.acquire("session").then((lease) => {
    order.push(2)
    return lease
  })
  const third = gate.acquire("session").then((lease) => {
    order.push(3)
    return lease
  })
  using other = await gate.acquire("another-session")
  expect(order).toEqual([])
  first[Symbol.dispose]()
  const next = await second
  first[Symbol.dispose]()
  await Bun.sleep(0)
  expect(order).toEqual([2])
  next[Symbol.dispose]()
  const last = await third
  expect(order).toEqual([2, 3])
  last[Symbol.dispose]()
})

test("failed admission releases both FIFO ownership and the durable lease", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    async fn() {
      await expect(
        (async () => {
          await using lease = await RuntimeAdmission.acquire("session")
          throw new Error("failed validation")
        })(),
      ).rejects.toThrow("failed validation")
      await using next = await RuntimeAdmission.acquire("session")
      expect(await next.during(async () => "accepted")).toBe("accepted")
    },
  })
})
