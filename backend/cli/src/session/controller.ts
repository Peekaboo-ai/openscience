import { AsyncLocalStorage } from "node:async_hooks"
import { Instance } from "../project/instance"
import { Session } from "."
import { MessageV2 } from "./message-v2"

/**
 * 对照 ZCode 328c1a0 turn-machine.ts 的显式状态转换和 pending input 所有权。
 * 这里只管理 OpenScience 回合的取消/接收生命周期；科研作业和 PTY 不归它销毁。
 */
export namespace SessionController {
  type Phase = "preparing" | "running" | "completed" | "cancelled"
  type Waiter = { resolve(value: MessageV2.WithParts): void; reject(reason?: unknown): void }
  type Owner = { controller: AbortController; phase: Phase; waiters: Waiter[] }
  const active = new Set<Owner>()
  const context = new AsyncLocalStorage<{ sessionID: string; owner: Owner }>()
  export const completed = Symbol("prompt.completed")
  const transitions: Record<Phase, readonly Phase[]> = {
    preparing: ["running", "completed", "cancelled"],
    running: ["completed", "cancelled"],
    completed: [],
    cancelled: [],
  }

  function transition(owner: Owner, next: Phase) {
    if (!transitions[owner.phase].includes(next))
      throw new Error(`Invalid session transition: ${owner.phase} -> ${next}`)
    owner.phase = next
  }

  const owners = Instance.state(
    () => new Map<string, Owner>(),
    async (items) => {
      const retiring = [...items.values()]
      // 与单回合取消一致：先移除旧 owner，abort listener 重入时不能再次转换终态。
      items.clear()
      for (const owner of retiring) {
        active.delete(owner)
        transition(owner, "cancelled")
        owner.controller.abort(new MessageV2.AbortedError({ message: "The runtime stopped." }))
        for (const waiter of owner.waiters.splice(0)) waiter.reject(owner.controller.signal.reason)
      }
    },
  )

  export const activeCount = () => active.size
  export const has = (sessionID: string) => owners().has(sessionID)
  export const ids = () => [...owners().keys()]
  export const signal = (sessionID: string) => owners().get(sessionID)?.controller.signal
  export function preparation(sessionID: string) {
    const current = context.getStore()
    return current?.sessionID === sessionID ? current.owner.controller : undefined
  }
  export function reserved(sessionID: string) {
    const owner = owners().get(sessionID)
    return owner?.phase === "preparing" ? owner.controller : undefined
  }
  export function assertPreparing(sessionID: string) {
    preparation(sessionID)?.signal.throwIfAborted()
  }
  export function assertNotBusy(sessionID: string) {
    if (has(sessionID)) throw new Session.BusyError(sessionID)
  }
  export function detached<T>(action: () => Promise<T>) {
    return context.exit(action)
  }

  function create(sessionID: string, phase: "preparing" | "running") {
    const owner: Owner = { controller: new AbortController(), phase, waiters: [] }
    owners().set(sessionID, owner)
    active.add(owner)
    return owner
  }

  export async function reserve<T>(sessionID: string, action: () => Promise<T>, abort?: AbortSignal) {
    abort?.throwIfAborted()
    assertNotBusy(sessionID)
    const owner = create(sessionID, "preparing")
    const signal = owner.controller.signal
    const cancelled = Promise.withResolvers<never>()
    const stop = () => {
      if (signal.reason !== completed) cancelled.reject(signal.reason)
    }
    const forward = () => owner.controller.abort(abort?.reason)
    signal.addEventListener("abort", stop, { once: true })
    abort?.addEventListener("abort", forward, { once: true })
    try {
      return await context.run({ sessionID, owner }, () => Promise.race([action(), cancelled.promise]))
    } finally {
      signal.removeEventListener("abort", stop)
      abort?.removeEventListener("abort", forward)
      // 调用者负责原有 flush/status 通知；这里以确切 owner 收口，不能释放后继任务。
      cancel(sessionID, signal, completed)
    }
  }

  export function start(sessionID: string) {
    const owner = owners().get(sessionID)
    if (owner?.phase === "running") return
    assertPreparing(sessionID)
    if (owner) {
      if (owner.controller !== preparation(sessionID)) throw new Session.BusyError(sessionID)
      transition(owner, "running")
      return owner.controller.signal
    }
    return create(sessionID, "running").controller.signal
  }

  export function cancel(sessionID: string, expected?: AbortSignal, reason?: unknown) {
    const owner = owners().get(sessionID)
    if (!owner || (expected && owner.controller.signal !== expected)) return false
    transition(owner, reason === completed ? "completed" : "cancelled")
    // 先释放所有权再发 abort，避免同步 abort listener 重入释放新 controller。
    owners().delete(sessionID)
    active.delete(owner)
    owner.controller.abort(reason)
    for (const waiter of owner.waiters) waiter.reject(reason)
    owner.waiters.length = 0
    return true
  }

  export function join(sessionID: string) {
    const owner = owners().get(sessionID)
    if (!owner || owner.phase !== "running") return Promise.reject(new Session.BusyError(sessionID))
    return new Promise<MessageV2.WithParts>((resolve, reject) => owner.waiters.push({ resolve, reject }))
  }

  export function resolve(sessionID: string, expected: AbortSignal, result: MessageV2.WithParts) {
    const owner = owners().get(sessionID)
    if (owner?.controller.signal !== expected) return
    for (const waiter of owner.waiters.splice(0)) waiter.resolve(result)
  }
}
