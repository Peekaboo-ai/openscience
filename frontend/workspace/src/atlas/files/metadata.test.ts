import { describe, expect, test } from "bun:test"
import { requestFileMetadata } from "./metadata"

const parse = (response: Response) => response.json()

describe("Files metadata deadlines", () => {
  test("a fetch that never settles exits loading and cancels the transport", async () => {
    let signal: AbortSignal | undefined
    const request = requestFileMetadata(
      async (_, init) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>(() => undefined)
      },
      "/file",
      { parse, timeout: 10 },
    )
    await expect(request).rejects.toMatchObject({ name: "TimeoutError" })
    expect(signal?.aborted).toBe(true)
  })

  test("a stalled filesystem response body is bounded and a later retry can succeed", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"version":'))
      },
    })
    await expect(
      requestFileMetadata(async () => new Response(body), "/session/ses_1/filesystem", { parse, timeout: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" })
    const retried = await requestFileMetadata(async () => Response.json({ version: 1 }), "/session/ses_1/filesystem", {
      parse,
    })
    expect(retried).toEqual({ version: 1 })
  })

  test("switching project aborts even a transport that ignores the signal", async () => {
    const owner = new AbortController()
    const request = requestFileMetadata(async () => new Promise<Response>(() => undefined), "/file", {
      parse,
      signal: owner.signal,
    })
    owner.abort(new DOMException("Project changed", "AbortError"))
    await expect(request).rejects.toMatchObject({ name: "AbortError" })
  })

  test("preserves listing scope and error parsing through the bounded read", async () => {
    const calls: Array<unknown> = []
    const response = await requestFileMetadata(
      async (path, init, query) => {
        calls.push({ path, query, aborted: init?.signal?.aborted })
        return Response.json([{ name: "report.md" }])
      },
      "/file",
      { parse, query: { path: "/scratch/results", sessionID: "ses_1" } },
    )
    expect(response).toEqual([{ name: "report.md" }])
    expect(calls).toEqual([{ path: "/file", query: { path: "/scratch/results", sessionID: "ses_1" }, aborted: false }])
  })
})
