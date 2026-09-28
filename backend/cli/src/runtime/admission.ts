import path from "node:path"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { FileLease } from "../util/file-lease"

/**
 * 移植 ZCode 328c1a0 command-inbox.ts 的 AsyncGateRegistry：FIFO 接收与幂等释放。
 * OpenScience 另保留文件租约，保证桌面、CLI 等不同进程不能同时接收同会话。
 */
export class AdmissionGate {
  private readonly tails = new Map<string, Promise<void>>()

  async acquire(key: string) {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const current = Promise.withResolvers<void>()
    const tail = previous.then(() => current.promise)
    this.tails.set(key, tail)
    await previous
    let released = false
    return {
      [Symbol.dispose]: () => {
        if (released) return
        released = true
        current.resolve()
        if (this.tails.get(key) === tail) this.tails.delete(key)
      },
    }
  }
}

export namespace RuntimeAdmission {
  const gate = new AdmissionGate()

  export async function acquire(sessionID: string): Promise<FileLease.Lease> {
    const identity = new Bun.CryptoHasher("sha256").update(Instance.project.id + "\0" + sessionID).digest("hex")
    const local = await gate.acquire(path.join(Global.Path.data, identity))
    try {
      const lease = await FileLease.acquire(path.join(Global.Path.data, "runtime-admission", identity))
      return {
        during: (action) => lease.during(action),
        async [Symbol.asyncDispose]() {
          try {
            await lease[Symbol.asyncDispose]()
          } finally {
            local[Symbol.dispose]()
          }
        },
      }
    } catch (error) {
      local[Symbol.dispose]()
      throw error
    }
  }
}
