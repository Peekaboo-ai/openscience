import { expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"
import { terminalOptions } from "./terminal-options"
import { decodePtyReplay, encodePtyReplay } from "@synsci/util/pty-replay"

const write = (terminal: Terminal, text: string) => new Promise<void>((resolve) => terminal.write(text, resolve))
const lines = (terminal: Terminal) =>
  Array.from(
    { length: terminal.buffer.active.length },
    (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? "",
  )

test("a wrapped shell prompt can redraw after widening without erasing previous command output", async () => {
  const terminal = new Terminal({ ...terminalOptions, cols: 42, rows: 24, allowProposedApi: true })
  try {
    const prompt = "(base) login02 openscience-terminal-regression-20260922 $ "
    await write(terminal, "CHECK_PREVIOUS_COMMAND\r\n" + prompt)
    terminal.resize(140, 24)
    // Bash/readline 在窄窗口占两行，SIGWINCH 后会上移一行再重绘。
    await write(terminal, "\r\x1b[K\x1b[A" + prompt)
    expect(lines(terminal)[0]).toBe("CHECK_PREVIOUS_COMMAND")
    expect(lines(terminal)[1]).toBe(prompt)
  } finally {
    terminal.dispose()
  }
})

test("tables retain line boundaries across split transport frames, scrolling, and repeated resizes", async () => {
  const terminal = new Terminal({ ...terminalOptions, cols: 42, rows: 24, allowProposedApi: true })
  try {
    const table = Array.from(
      { length: 50 },
      (_, i) => `env_${String(i).padStart(2, "0")}    /public/home/research/miniconda3/envs/env_${i}`,
    )
    const output = table.join("\r\n") + "\r\n"
    for (let offset = 0; offset < output.length; offset += 37) await write(terminal, output.slice(offset, offset + 37))
    for (const cols of [140, 55, 100, 140]) terminal.resize(cols, 24)
    expect(lines(terminal).filter(Boolean)).toEqual(table)
  } finally {
    terminal.dispose()
  }
})

test("reconnection uses recorded geometry rather than the new viewport width", async () => {
  const terminal = new Terminal({ ...terminalOptions, cols: 140, rows: 24, allowProposedApi: true })
  const prompt = "(base) login02 openscience-terminal-regression-20260922 $ "
  try {
    for (const [cols, text] of [
      [42, "KEEP_HISTORY\r\n" + prompt],
      [140, "\r\x1b[K\x1b[A" + prompt],
    ] as const) {
      const frame = decodePtyReplay(encodePtyReplay({ type: "resize", size: { cols, rows: 24 } }).buffer)
      if (frame?.type !== "resize") throw new Error("Invalid replay geometry")
      terminal.resize(frame.size.cols, frame.size.rows)
      await write(terminal, text)
    }
    expect(lines(terminal)[0]).toBe("KEEP_HISTORY")
    expect(lines(terminal)[1]).toBe(prompt)
    expect(
      decodePtyReplay(new TextEncoder().encode('{"type":"resize","size":{"cols":0,"rows":1}}').buffer),
    ).toBeUndefined()
  } finally {
    terminal.dispose()
  }
})
