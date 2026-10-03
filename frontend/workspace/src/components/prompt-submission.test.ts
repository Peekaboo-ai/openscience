import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { canRestoreFailedSubmission, createPromptRecovery } from "./prompt-submission"

const empty = (): Prompt => [{ type: "text", content: "", start: 0, end: 0 }]
const text = (content: string): Prompt => [{ type: "text", content, start: 0, end: content.length }]

function draft(content: string) {
  let value = text(content)
  let revision = 0
  return {
    current: () => value,
    revision: () => revision,
    set(next: Prompt) {
      value = next
      revision++
    },
    reset() {
      value = empty()
      revision++
    },
  }
}

describe("failed composer submissions", () => {
  test("a delayed failure restores its source conversation without replacing another conversation", async () => {
    const source = draft("research A")
    const next = draft("research B")
    let active = source
    const recovery = createPromptRecovery(source, source.current(), 10)
    recovery.clear()
    const failed = Promise.withResolvers<void>()
    const settled = failed.promise.catch(() => recovery.restore())
    active = next
    failed.reject(new Error("offline"))
    expect(await settled).toBe(true)
    expect(active.current()).toEqual(text("research B"))
    expect(source.current()).toEqual(text("research A"))
    expect(recovery.restore()).toBe(false)
  })

  test("a first failure cannot restore over a later send or an intentionally cleared draft", () => {
    const source = draft("first")
    const first = createPromptRecovery(source, source.current(), 5)
    first.clear()
    source.set(text("second"))
    const second = createPromptRecovery(source, source.current(), 6)
    second.clear()
    expect(first.restore()).toBe(false)
    expect(second.restore()).toBe(true)
    const third = createPromptRecovery(source, source.current(), 6)
    third.clear()
    source.set(text("changed my mind"))
    source.reset()
    expect(third.restore()).toBe(false)
  })

  test("a newly created session owns failure recovery while preserving any newer destination draft", () => {
    const source = draft("start research")
    const created = draft("")
    const recovery = createPromptRecovery(source, source.current(), 14)
    recovery.clear()
    recovery.transfer(created)
    expect(recovery.restore()).toBe(true)
    expect(source.current()).toEqual(empty())
    expect(created.current()).toEqual(text("start research"))
    const retry = createPromptRecovery(source, text("old retry"), 9)
    retry.clear()
    retry.transfer(created)
    expect(retry.restore()).toBe(false)
  })
  test("restores the sent message when a delayed failure finds the composer untouched", async () => {
    let composer = empty()
    let rejectRequest!: (reason: Error) => void
    const request = new Promise<void>((_, reject) => {
      rejectRequest = reject
    }).catch(() => {
      if (canRestoreFailedSubmission(composer, "normal")) composer = text("original message")
    })

    rejectRequest(new Error("delayed failure"))
    await request

    expect(composer).toEqual(text("original message"))
  })

  test("preserves a new draft typed before a delayed failure settles", async () => {
    let composer = empty()
    let rejectRequest!: (reason: Error) => void
    const request = new Promise<void>((_, reject) => {
      rejectRequest = reject
    }).catch(() => {
      if (canRestoreFailedSubmission(composer, "normal")) composer = text("original message")
    })

    composer = text("new draft")
    rejectRequest(new Error("delayed failure"))
    await request

    expect(composer).toEqual(text("new draft"))
  })

  test("treats attachments and a newly selected shell mode as newer composer state", () => {
    const attachment: Prompt = [
      {
        type: "image",
        id: "image-next",
        filename: "next.png",
        mime: "image/png",
        dataUrl: "data:image/png;base64,AA==",
      },
    ]

    expect(canRestoreFailedSubmission(attachment, "normal")).toBe(false)
    expect(canRestoreFailedSubmission(empty(), "shell")).toBe(false)
  })
})
