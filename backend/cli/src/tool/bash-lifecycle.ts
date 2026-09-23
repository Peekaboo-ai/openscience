/** 权限等待不计入命令预算；获准后的准备和执行共用同一截止时间。 */
export class BashLifecycle implements Disposable {
  readonly started = Date.now()
  readonly signal: AbortSignal
  readonly controller = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private heartbeat: ReturnType<typeof setInterval>
  private phase = "preparing"
  private phaseAt = this.started
  private ended = false

  constructor(
    abort: AbortSignal,
    readonly timeout: number,
    private publish: (progress: { phase: string; startedAt: number; phaseAt: number; elapsedMs: number }) => void,
  ) {
    this.signal = AbortSignal.any([abort, this.controller.signal])
    if (timeout > 0)
      this.timer = setTimeout(
        () => this.controller.abort(new Error(`Shell timed out during ${this.phase} after ${timeout} ms`)),
        timeout,
      )
    this.heartbeat = setInterval(() => this.report(), 1000)
    this.heartbeat.unref?.()
    this.report()
  }

  get timedOut() {
    return this.controller.signal.aborted
  }

  stage(phase: string, check = true) {
    this.phase = phase
    this.phaseAt = Date.now()
    this.report()
    if (check) this.signal.throwIfAborted()
  }

  private report() {
    if (this.ended) return
    this.publish({
      phase: this.phase,
      startedAt: this.started,
      phaseAt: this.phaseAt,
      elapsedMs: Date.now() - this.started,
    })
  }

  // 仅用于读取/观察。持有锁、创建进程等操作必须自行检查信号并完成回收，不能遗留迟到的副作用。
  async read<T>(operation: Promise<T>): Promise<T> {
    if (this.signal.aborted) void operation.catch(() => undefined)
    this.signal.throwIfAborted()
    let abort: () => void = () => {}
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(this.signal.reason)
      this.signal.addEventListener("abort", abort, { once: true })
      if (this.signal.aborted) abort()
    })
    return Promise.race([operation, cancelled]).finally(() => this.signal.removeEventListener("abort", abort))
  }

  [Symbol.dispose]() {
    this.ended = true
    clearTimeout(this.timer)
    clearInterval(this.heartbeat)
  }
}
