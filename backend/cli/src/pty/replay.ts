import type { PtySize } from "@synsci/util/pty-replay"

export namespace Replay {
  const LIMIT = 1024 * 1024 * 2
  const CHUNK = 64 * 1024

  /** Bounded canonical PTY output kept as a ring of transport-sized chunks.
   *  Appends only touch the tail, and whole chunks fall off the head once the
   *  byte budget is exceeded, so a full ring never copies its 2 MB per write. */
  export type Ring = {
    chunks: string[]
    length: number
    geometry: PtySize[]
    size: PtySize
  }

  export function create(): Ring {
    return { chunks: [], length: 0, geometry: [], size: { cols: 80, rows: 24 } }
  }

  export function resize(ring: Ring, size: PtySize) {
    ring.size = { ...size }
  }

  function push(ring: Ring, piece: string) {
    const last = ring.chunks.at(-1)
    // Pack small writes into the tail chunk so a byte-at-a-time stream does
    // not grow the ring to millions of entries.
    const size = ring.geometry.at(-1)
    const packed =
      last !== undefined &&
      last.length + piece.length <= CHUNK &&
      size?.cols === ring.size.cols &&
      size.rows === ring.size.rows
    if (packed) ring.chunks[ring.chunks.length - 1] = last + piece
    if (!packed) {
      ring.chunks.push(piece)
      ring.geometry.push(ring.size)
    }
    ring.length += piece.length
  }

  export function append(ring: Ring, data: string) {
    for (let offset = 0; offset < data.length; offset += CHUNK) push(ring, data.slice(offset, offset + CHUNK))
    // 即使每次输出前都发生缩放，几何元数据也必须保持有界。
    while (ring.length > LIMIT || ring.chunks.length > 4096) {
      const head = ring.chunks.shift()!
      ring.geometry.shift()
      ring.length -= head.length
    }
    return ring
  }

  export function text(ring: Ring) {
    return ring.chunks.join("")
  }

  /** Replay frames, each at most one transport chunk, in stream order. */
  export function chunks(ring: Ring) {
    return [...ring.chunks]
  }

  export function frames(ring: Ring) {
    return ring.chunks.map((data, index) => ({ data, size: ring.geometry[index] }))
  }
}
