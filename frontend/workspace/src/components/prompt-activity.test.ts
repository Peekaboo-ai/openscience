import { expect, test } from "bun:test"
import { createPromptActivity } from "./prompt-activity"

test("all failed submissions release their shared optimistic busy state in either order", () => {
  for (const reverse of [false, true]) {
    const activity = createPromptActivity()
    const first = activity.add("session", false)
    const later = activity.add("session", true)
    const finish = reverse ? [later, first] : [first, later]
    expect(finish[0](false)).toBe(false)
    expect(finish[1](false)).toBe(true)
    expect(finish[1](false)).toBe(false)
  }
})

test("accepted requests and pre-existing work retain busy state when guidance fails", () => {
  const activity = createPromptActivity()
  const first = activity.add("new-work", false)
  const guidance = activity.add("new-work", true)
  expect(first(true)).toBe(false)
  expect(guidance(false)).toBe(false)
  expect(activity.add("existing-work", true)(false)).toBe(false)
})

test("settling one session cannot release another session or a later attempt", () => {
  const activity = createPromptActivity()
  const first = activity.add("A", false)
  const other = activity.add("B", false)
  expect(first(false)).toBe(true)
  const later = activity.add("A", false)
  expect(first(true)).toBe(false)
  expect(other(false)).toBe(true)
  expect(later(false)).toBe(true)
})
