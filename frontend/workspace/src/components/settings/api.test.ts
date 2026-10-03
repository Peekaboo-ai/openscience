import { describe, expect, test } from "bun:test"
import { SettingsApiError, settingsApi } from "./api"

const base = "http://x"
const path = "/settings/local"

describe("settingsApi", () => {
  test("times out a transport that ignores abort and permits an independent retry", async () => {
    let signal: AbortSignal | null | undefined
    const stalled = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal
      return new Promise<Response>(() => {})
    }) as typeof fetch
    await expect(settingsApi(base, stalled, path, undefined, 15)).rejects.toMatchObject({ name: "TimeoutError" })
    expect(signal?.aborted).toBe(true)
    const healthy = (async () => Response.json({ recovered: true })) as unknown as typeof fetch
    expect(await settingsApi<{ recovered: boolean }>(base, healthy, path)).toEqual({ recovered: true })
  })

  test("the deadline includes a stalled response body", async () => {
    const stalled = (async () =>
      new Response(new ReadableStream(), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    await expect(settingsApi(base, stalled, path, undefined, 15)).rejects.toMatchObject({ name: "TimeoutError" })
  })

  test("honors caller cancellation and preserves Headers instances", async () => {
    const controller = new AbortController()
    controller.abort()
    let called = false
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      called = true
      expect(new Headers(init?.headers).get("x-test")).toBe("scope")
      return Response.json({ ok: true })
    }) as typeof fetch
    await expect(settingsApi(base, fetchFn, path, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(called).toBe(false)
    await settingsApi(base, fetchFn, path, { headers: new Headers({ "x-test": "scope" }) })
    expect(called).toBe(true)
  })

  test("throws a descriptive error when a 200 response is not JSON", async () => {
    const fetchFn = (async () =>
      new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof fetch

    const error = await settingsApi<never>(base, fetchFn, path).catch((e: Error) => e)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("/settings/local")
    expect(error.message).toContain("Expected JSON")
    expect(error.message).not.toContain("Unexpected token")
  })

  test("resolves with parsed JSON on a normal 200 response", async () => {
    const fetchFn = (async () => Response.json({ ok: true }, { status: 200 })) as unknown as typeof fetch

    expect(await settingsApi<{ ok: boolean }>(base, fetchFn, path)).toEqual({ ok: true })
  })

  test("resolves with undefined on 204", async () => {
    const fetchFn = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch

    expect(await settingsApi(base, fetchFn, path)).toBeUndefined()
  })

  test("preserves the existing non-ok error path", async () => {
    const fetchFn = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch

    await expect(settingsApi(base, fetchFn, path)).rejects.toThrow(/boom|500/)
  })

  test("turns a JSON route error into a readable typed error", async () => {
    const fetchFn = (async () =>
      Response.json(
        { error: "not_found", path: "/settings/local/context" },
        { status: 404 },
      )) as unknown as typeof fetch

    const error = await settingsApi(base, fetchFn, path).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(SettingsApiError)
    if (!(error instanceof SettingsApiError)) throw error
    expect(error.status).toBe(404)
    expect(error.code).toBe("not_found")
    expect(error.message).toBe("Route not found: /settings/local/context")
    expect(error.message).not.toContain("{")
  })

  test("removes a trailing slash from a mounted route root", async () => {
    let requested = ""
    const fetchFn = (async (input: RequestInfo | URL) => {
      requested = String(input)
      return Response.json({ ok: true })
    }) as typeof fetch

    await settingsApi("http://127.0.0.1:4096/", fetchFn, "/settings/local/")

    expect(requested).toBe("http://127.0.0.1:4096/settings/local")
  })
})
