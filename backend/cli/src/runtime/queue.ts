import path from "node:path"
import z from "zod"
import { Global } from "../global"
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { ProcessIdentity } from "../process/process-identity"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Storage } from "../storage/storage"
import { FileLease } from "../util/file-lease"
import { RuntimeEvents } from "./events"
import { RuntimeRuns } from "./runs"

export namespace RuntimeQueue {
  const Item = z.object({ id: z.string(), input: z.lazy(() => RuntimeRuns.Input), createdAt: z.number() })
  export const Snapshot = z
    .object({
      sessionID: Identifier.schema("session"),
      revision: z.number().int().nonnegative(),
      paused: z.boolean(),
      reason: z.string().optional(),
      dispatching: z.string().optional(),
      activeRunID: z.lazy(() => RuntimeRuns.RunID).optional(),
      items: z.array(Item),
    })
    .meta({ ref: "RuntimeQueueSnapshot" })
  const State = Snapshot.omit({ activeRunID: true }).extend({
    owner: z.object({ pid: z.number(), identity: z.string() }).optional(),
    barrier: z.lazy(() => RuntimeRuns.RunID).optional(),
    guiding: z.object({ id: z.string(), runID: z.lazy(() => RuntimeRuns.RunID) }).optional(),
    receipts: z.record(
      z.string(),
      z.object({
        fingerprint: z.string(),
        runID: z.lazy(() => RuntimeRuns.RunID).optional(),
        guidedTo: z.lazy(() => RuntimeRuns.RunID).optional(),
      }),
    ),
  })
  type State = z.infer<typeof State>
  export const Mutation = z
    .object({
      sessionID: Identifier.schema("session"),
      revision: z.number().int().nonnegative(),
      change: z.discriminatedUnion("type", [
        z.object({ type: z.literal("pause") }),
        z.object({ type: z.literal("resume") }),
        z.object({ type: z.literal("remove"), id: z.string() }),
        z.object({ type: z.literal("move"), id: z.string(), before: z.string().nullable() }),
        z.object({ type: z.literal("edit"), id: z.string(), text: z.string().trim().min(1).max(1_000_000) }),
        z.object({ type: z.literal("guide"), id: z.string(), runID: z.lazy(() => RuntimeRuns.RunID) }),
      ]),
    })
    .strict()

  export class ConflictError extends Error {
    constructor(message = "The queue changed in another window. Refresh it and try again.") {
      super(message)
    }
  }

  const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
  const key = (sessionID: string) => ["runtime_queue", Instance.project.id, digest(sessionID)]
  const lock = (sessionID: string) =>
    path.join(Global.Path.data, "runtime-queue", digest(Instance.project.id + "\0" + sessionID))
  async function read(sessionID: string): Promise<State> {
    await Session.get(sessionID)
    return Storage.read(key(sessionID))
      .then((value) => State.parse(value))
      .catch((error) => {
        if (!Storage.NotFoundError.isInstance(error)) throw error
        return { sessionID, revision: 0, paused: false, items: [], receipts: {} }
      })
  }
  async function write(state: State) {
    state.revision++
    await Storage.write(key(state.sessionID), state)
  }
  async function owner() {
    const identity = await ProcessIdentity.capture(process.pid)
    if (!identity) throw new Error("Could not identify the queue owner")
    return { pid: process.pid, identity }
  }
  async function recover(state: State) {
    if (!state.items.length || !state.owner || (await ProcessIdentity.owns(state.owner.pid, state.owner.identity)))
      return
    state.paused = true
    state.reason = "runtime_restarted"
    state.owner = await owner()
    await write(state)
  }
  export async function get(sessionID: string) {
    await using lease = await FileLease.acquire(lock(sessionID))
    const state = await read(sessionID)
    await recover(state)
    return Snapshot.parse({ ...state, activeRunID: await RuntimeEvents.activeRun(sessionID) })
  }

  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, value]) => value !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, canonical(value)]),
      )
    return value
  }

  export async function enqueue(value: RuntimeRuns.Input) {
    const input = RuntimeRuns.Input.parse(value)
    const request = input.requestID ?? input.messageID
    if (!request) throw new ConflictError("Queued prompts require a stable request ID")
    const id = digest(request)
    const fingerprint = digest(JSON.stringify(canonical(input)))
    await (async () => {
      await using lease = await FileLease.acquire(lock(input.sessionID))
      const state = await read(input.sessionID)
      await recover(state)
      const receipt = state.receipts[id]
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new ConflictError("This request ID belongs to another queued prompt")
        return
      }
      if (state.items.length >= 100) throw new ConflictError("A session can hold at most 100 queued prompts")
      // 内容、附件、模型与推理设置整体保存；队列不能仅保存文本再重新拼出请求。
      state.items.push({
        id,
        input: { ...input, messageID: input.messageID ?? Identifier.ascending("message") },
        createdAt: Date.now(),
      })
      state.receipts[id] = { fingerprint }
      state.owner = await owner()
      state.barrier ??= await RuntimeEvents.activeRun(input.sessionID)
      await write(state)
    })()
    await drain(input.sessionID)
    return get(input.sessionID)
  }

  export async function mutate(value: z.infer<typeof Mutation>) {
    const input = Mutation.parse(value)
    const pending = await (async () => {
      await using lease = await FileLease.acquire(lock(input.sessionID))
      const state = await read(input.sessionID)
      await recover(state)
      const change = input.change
      // 响应丢失后的重试仍可跨队列版本复用回执，但必须对应同一条消息和目标运行。
      if (change.type === "guide" && state.receipts[change.id]?.guidedTo === change.runID) return
      const retrying =
        change.type === "guide" && state.guiding?.id === change.id && state.guiding.runID === change.runID
      if (state.revision !== input.revision && !retrying) throw new ConflictError()
      if (change.type === "pause" || change.type === "resume") {
        state.paused = change.type === "pause"
        state.reason = state.paused ? "user" : undefined
        state.owner = await owner()
        // 显式继续只解除已结束的屏障；仍在运行的任务必须先结束。
        if (!state.paused && state.barrier) {
          const run = await RuntimeRuns.get(input.sessionID, state.barrier)
          if (!["accepted", "running"].includes(run.state)) state.barrier = undefined
        }
      } else {
        const index = state.items.findIndex((item) => item.id === change.id)
        if (index < 0 || (state.dispatching === change.id && !retrying))
          throw new ConflictError("This queued prompt has already been submitted")
        const item = state.items[index]!
        if (change.type === "guide") {
          if (state.dispatching && !retrying) throw new ConflictError("Another queued prompt is still being submitted")
          if (!retrying) {
            state.dispatching = item.id
            state.guiding = { id: item.id, runID: change.runID }
            await write(state)
          }
          return { item, runID: change.runID }
        }
        if (change.type === "remove") state.items.splice(index, 1)
        if (change.type === "edit") {
          if (item.input.message !== undefined) item.input.message = change.text
          else {
            const text = item.input.parts?.find((part) => part.type === "text")
            if (text?.type === "text") {
              text.text = change.text
            } else item.input.parts?.unshift({ type: "text", text: change.text })
          }
        }
        if (change.type === "move" && change.before !== change.id) {
          if (change.before !== null && !state.items.some((item) => item.id === change.before))
            throw new ConflictError()
          state.items.splice(index, 1)
          const target =
            change.before === null ? state.items.length : state.items.findIndex((item) => item.id === change.before)
          state.items.splice(target, 0, item)
        }
      }
      await write(state)
    })()
    if (pending) await guide(input.sessionID, pending.item, pending.runID)
    if (input.change.type === "resume") await drain(input.sessionID, true)
    return get(input.sessionID)
  }

  async function guide(sessionID: string, item: z.infer<typeof Item>, runID: string) {
    try {
      const run = await SessionPrompt.detached(() =>
        RuntimeRuns.guide({ ...item.input, requestID: `queue:${item.id}` }, runID),
      )
      await using lease = await FileLease.acquire(lock(sessionID))
      const state = await read(sessionID)
      if (state.receipts[item.id]?.guidedTo === run.runID) return
      if (state.guiding?.id !== item.id || state.guiding.runID !== runID)
        throw new ConflictError("The pending guidance changed before its receipt was saved")
      state.receipts[item.id]!.runID = run.runID
      state.receipts[item.id]!.guidedTo = run.runID
      state.items = state.items.filter((entry) => entry.id !== item.id)
      state.dispatching = undefined
      state.guiding = undefined
      state.barrier = run.runID
      await write(state)
    } catch (error) {
      await using lease = await FileLease.acquire(lock(sessionID))
      const state = await read(sessionID)
      if (state.receipts[item.id]?.guidedTo === runID) return
      if (state.guiding?.id !== item.id || state.guiding.runID !== runID) throw error
      // 明确拒绝接收时尚无副作用，允许继续编辑或删除；未知失败保留原提交意图供精确恢复。
      if (error instanceof RuntimeEvents.ActiveRunError) {
        state.dispatching = undefined
        state.guiding = undefined
        state.barrier ??= runID
        await write(state)
        throw new ConflictError("The selected run has ended or changed. This prompt remains queued.")
      }
      if (error instanceof RuntimeRuns.PreparationError) {
        // 附件拒绝/读取失败发生在写入对话前，释放条目供修正；已经提交的未知失败仍保留 claim。
        state.dispatching = undefined
        state.guiding = undefined
      }
      state.paused = true
      state.reason = "submission_failed"
      await write(state)
      throw error
    } finally {
      // 原运行可能在引导回执写入队列前已收尾；清理 claim 后再次按屏障的真实终态推进。
      await drain(sessionID)
    }
  }

  export async function pause(sessionID: string, reason = "user", runID?: string) {
    await using lease = await FileLease.acquire(lock(sessionID))
    // 旧运行的取消重试不能暂停后继任务；在队列锁内核对当前运行，避免跨代停止。
    if (runID && (await RuntimeEvents.activeRun(sessionID)) !== runID) return
    const state = await read(sessionID)
    if (!state.items.length) return
    state.paused = true
    state.reason = reason
    await write(state)
  }

  export async function settled(sessionID: string, run: RuntimeRuns.Run) {
    const ready = await (async () => {
      await using lease = await FileLease.acquire(lock(sessionID))
      const state = await Storage.read(key(sessionID))
        .then((value) => State.parse(value))
        .catch((error) => {
          if (!Storage.NotFoundError.isInstance(error)) throw error
        })
      // 终态写入与异步收尾之间可能已启动下一轮；只能暂停等待本轮的队列。
      if (!state?.items.length || state.barrier !== run.runID) return false
      if (run.state === "completed") return true
      state.paused = true
      state.reason = run.state
      await write(state)
      return false
    })()
    if (ready) await drain(sessionID)
  }

  async function drain(sessionID: string, recoverGuidance = false) {
    const pending = await (async () => {
      await using lease = await FileLease.acquire(lock(sessionID))
      const state = await read(sessionID)
      await recover(state)
      while (!state.paused && state.items.length) {
        // 接收引导后重启必须核对原回执，不能把同一条消息改成新任务再次执行。
        if (state.guiding) {
          if (!recoverGuidance) return
          const item = state.items.find((entry) => entry.id === state.guiding!.id)
          if (!item) throw new ConflictError("The pending guidance could not be recovered")
          return { item, runID: state.guiding.runID }
        }
        if (state.barrier) {
          const run = await RuntimeRuns.get(sessionID, state.barrier)
          if (["accepted", "running"].includes(run.state)) return
          if (run.state !== "completed") {
            state.paused = true
            state.reason = run.state
            await write(state)
            return
          }
          state.barrier = undefined
        }
        const active = await RuntimeEvents.activeRun(sessionID)
        if (active) {
          // 直接发送可能抢在旧运行收尾后取得会话；后继运行必须接管队列屏障才能继续推进。
          state.barrier = active
          await write(state)
          return
        }
        try {
          SessionPrompt.assertNotBusy(sessionID)
        } catch (error) {
          if (error instanceof Session.BusyError) {
            // Shell/旧控制器没有可跟踪的持久运行结果，显式暂停等待用户继续，避免静默停滞或取消后启动下一项。
            state.paused = true
            state.reason = "session_busy"
            await write(state)
            return
          }
          throw error
        }
        const item = state.items[0]!
        // 先持久化提交意图；崩溃后使用相同幂等请求恢复回执，绝不重复执行副作用。
        state.dispatching = item.id
        await write(state)
        try {
          const receipt = await SessionPrompt.detached(() =>
            RuntimeRuns.prompt({ ...item.input, requestID: `queue:${item.id}`, delivery: "start" }),
          )
          state.receipts[item.id]!.runID = receipt.runID
          state.items.shift()
          state.dispatching = undefined
          state.barrier = receipt.runID
          await write(state)
        } catch (error) {
          if (error instanceof RuntimeEvents.ActiveRunError) {
            state.dispatching = undefined
            // 接收前最后一刻可能被直接发送抢占；记录当时的具体运行，即使它已结束也不能丢失其终态。
            state.barrier = error.runID ?? (await RuntimeEvents.activeRun(sessionID))
            await write(state)
            continue
          }
          state.paused = true
          state.reason = "submission_failed"
          await write(state)
          throw error
        }
      }
    })()
    // 只用持久 claim 占有该条消息；附件授权期间允许查询、暂停以及编辑其他排队项。
    if (pending) {
      await guide(sessionID, pending.item, pending.runID)
      await drain(sessionID)
    }
  }
}
