/**
 * 用户主动升级时的中断原因。保留未完成 transcript，工具调用写入明确中断原因。
 * 有持久回执的根回合遵循 RuntimeRuns 的恢复政策，不能由项目预热重新执行；
 * 无回执的旧会话仍由 resumeInterrupted 兼容处理。
 */
export namespace SessionRestart {
  export class Interruption extends Error {
    constructor() {
      super("Paused to install an update; review the interrupted turn after the restart before continuing.")
      this.name = "RestartInterruption"
    }
  }

  export function interruption(value: unknown): Interruption | undefined {
    return value instanceof Interruption ? value : undefined
  }
}
