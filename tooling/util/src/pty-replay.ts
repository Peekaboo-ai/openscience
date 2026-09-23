export type PtySize = { cols: number; rows: number }
export type PtyReplayFrame = { type: "resize"; size: PtySize } | { type: "ready" }

export function encodePtyReplay(frame: PtyReplayFrame) {
  return new TextEncoder().encode(JSON.stringify(frame))
}

export function decodePtyReplay(data: ArrayBuffer): PtyReplayFrame | undefined {
  if (data.byteLength > 512) return
  try {
    const frame = JSON.parse(new TextDecoder().decode(data))
    if (frame.type === "ready") return { type: "ready" }
    if (frame.type !== "resize") return
    const size = frame.size
    if (!size || ![size.cols, size.rows].every((value) => Number.isInteger(value) && value >= 1 && value <= 1000))
      return
    return { type: "resize", size: { cols: size.cols, rows: size.rows } }
  } catch {
    return
  }
}
