import { afterAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"
import type { InspectionSource } from "./inspection"

const server = await createTestServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const solidjs = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const subject = (await server.ssrLoadModule("/src/science/formats/inspection.ts")) as typeof import("./inspection")
afterAll(() => server.close())
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

describe("scientific container inspection", () => {
  test("changing servers reloads the same path and discards the old response", async () => {
    const pending = Promise.withResolvers<Response>()
    const signals: AbortSignal[] = []
    const root = solidjs.createRoot((dispose) => {
      const [source, setSource] = solidjs.createSignal<InspectionSource>({ scope: "server_a", path: "/data/a.h5ad" })
      const [inspection] = subject.createBinaryInspection(async (_, init) => {
        signals.push(init!.signal!)
        return signals.length === 1 ? pending.promise : Response.json({ format: "h5ad", name: "new server" })
      }, source)
      return { inspection, setSource, dispose }
    })
    try {
      await settle()
      root.setSource({ scope: "server_b", path: "/data/a.h5ad" })
      await settle()
      expect(signals[0].aborted).toBe(true)
      expect(signals).toHaveLength(2)
      expect(root.inspection.latest?.name).toBe("new server")
      pending.resolve(Response.json({ format: "h5ad", name: "old server" }))
      await settle()
      expect(root.inspection.latest?.name).toBe("new server")
    } finally {
      root.dispose()
    }
  })

  test("closing the preview aborts an inspection still in progress", async () => {
    let signal: AbortSignal | undefined
    const dispose = solidjs.createRoot((dispose) => {
      subject.createBinaryInspection(
        async (_, init) => {
          signal = init?.signal ?? undefined
          return new Promise<Response>(() => undefined)
        },
        () => ({ scope: "server_a", path: "/data/large.h5ad" }),
      )
      return dispose
    })
    await settle()
    expect(signal?.aborted).toBe(false)
    dispose()
    await settle()
    expect(signal?.aborted).toBe(true)
  })

  test("a transport that ignores abort leaves loading after its deadline and supports Retry", async () => {
    let calls = 0
    const root = solidjs.createRoot((dispose) => {
      const [inspection, actions] = subject.createBinaryInspection(
        async () =>
          ++calls === 1 ? new Promise<Response>(() => undefined) : Response.json({ format: "bam", name: "reads.bam" }),
        () => ({ scope: "server_a", path: "/data/reads.bam" }),
        10,
      )
      return { inspection, actions, dispose }
    })
    try {
      await settle(30)
      expect(root.inspection.loading).toBe(false)
      expect(root.inspection.error?.name).toBe("TimeoutError")
      await root.actions.refetch()
      expect(root.inspection.error).toBeUndefined()
      expect(root.inspection.latest?.name).toBe("reads.bam")
    } finally {
      root.dispose()
    }
  })
})
