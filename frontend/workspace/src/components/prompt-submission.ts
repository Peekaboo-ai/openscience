import type { Prompt } from "@/context/prompt"

/**
 * A failed request may restore the message it tried to send only while the
 * composer is still in the exact cleared state left by that submission.
 * Anything typed or attached afterward belongs to the next draft and wins.
 */
export function canRestoreFailedSubmission(current: Prompt, mode: "normal" | "shell") {
  const part = current[0]
  return mode === "normal" && current.length === 1 && part?.type === "text" && part.content === ""
}

type Draft = {
  current: () => Prompt
  revision: () => number
  reset: () => void
  set: (value: Prompt, cursor?: number) => void
}

export function createPromptRecovery(draft: Draft, value: Prompt, cursor: number) {
  let cleared: number | undefined
  return {
    clear() {
      draft.reset()
      cleared = draft.revision()
    },
    transfer(target: Draft) {
      const untouched = cleared !== undefined && draft.revision() === cleared
      draft = target
      cleared = untouched && canRestoreFailedSubmission(target.current(), "normal") ? target.revision() : undefined
    },
    restore(mode: "normal" | "shell" = "normal") {
      // 后续编辑或再次发送都会推进版本；即使输入框再次为空，也不恢复旧请求。
      if (cleared === undefined || draft.revision() !== cleared || !canRestoreFailedSubmission(draft.current(), mode))
        return false
      draft.set(value, cursor)
      cleared = undefined
      return true
    },
  }
}
