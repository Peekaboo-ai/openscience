export type TerminalSize = { cols: number; rows: number }

// 远端 HTTP 延迟不可预测；同一终端只允许一个尺寸写入在途，随后合并到最新尺寸。
export function createTerminalGeometry(send: (size: TerminalSize) => Promise<unknown>) {
  let desired: TerminalSize | undefined
  let applied: TerminalSize | undefined
  let pending: Promise<void> | undefined
  let disposed = false
  const equal = (a?: TerminalSize, b?: TerminalSize) => a?.cols === b?.cols && a?.rows === b?.rows
  async function drain() {
    while (!disposed && desired && !equal(desired, applied)) {
      const size = desired
      await send(size)
      applied = size
    }
  }
  return {
    set(size: TerminalSize) {
      if (Number.isInteger(size.cols) && size.cols > 0 && Number.isInteger(size.rows) && size.rows > 0)
        desired = { ...size }
    },
    flush(): Promise<void> {
      if (!pending)
        pending = drain().finally(() => {
          pending = undefined
        })
      return pending
    },
    invalidate() {
      applied = undefined
    },
    dispose() {
      disposed = true
    },
  }
}
