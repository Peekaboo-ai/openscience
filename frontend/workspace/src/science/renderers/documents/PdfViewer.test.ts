import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../../test/vite"

const server = await createTestServer({
  root: fileURLToPath(new URL("../../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const subject = (await server.ssrLoadModule(
  "/src/science/renderers/documents/PdfViewer.tsx",
)) as typeof import("./PdfViewer")
const solidjs = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const stores = (await server.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
type Library = Awaited<ReturnType<NonNullable<Parameters<typeof subject.PdfViewer>[0]["load"]>>>
const cleanups: Array<() => void> = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))
const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(view, host)
  cleanups.push(dispose)
  return { host, dispose }
}
type PageReader = Awaited<ReturnType<Library["getDocument"]>["promise"]>["getPage"]
const library = (getPage: PageReader) =>
  ({
    GlobalWorkerOptions: { workerSrc: "" },
    getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage }), destroy: async () => {} }),
  }) satisfies Library

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

describe("PDF preview lifetime", () => {
  test("reacts to in-place store byte updates, reports corrupt data, and recovers without replacing the data object", async () => {
    const [state, setState] = stores.createStore({ data: { bytes: new Uint8Array([1, 2, 3]) } })
    const original = state.data
    const sources: number[][] = []
    let destroyed = 0
    const lib: Library = {
      GlobalWorkerOptions: { workerSrc: "" },
      getDocument: (source) => {
        const bytes = source.data as Uint8Array
        sources.push([...bytes])
        return {
          promise:
            bytes[0] === 9
              ? Promise.reject(new Error("Invalid PDF structure"))
              : Promise.resolve({
                  numPages: 0,
                  getPage: async () => {
                    throw new Error("unused")
                  },
                }),
          destroy: async () => {
            destroyed++
          },
        }
      },
    }
    const { host } = mount(() =>
      subject.PdfViewer({
        kind: "pdf",
        get data() {
          return state.data
        },
        load: async () => lib,
      }),
    )
    await settle()
    setState("data", { bytes: new Uint8Array([9, 9]) })
    await settle()
    expect(state.data).toBe(original)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Invalid PDF structure")
    expect(destroyed).toBe(1)
    setState("data", { bytes: new Uint8Array([4, 5, 6]) })
    await settle()
    expect(state.data).toBe(original)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(sources).toEqual([
      [1, 2, 3],
      [9, 9],
      [4, 5, 6],
    ])
    expect(destroyed).toBe(2)
  })

  test("reports malformed base64 inside the viewer without starting a worker", async () => {
    let calls = 0
    const { host } = mount(() =>
      subject.PdfViewer({
        kind: "pdf",
        data: "data:application/pdf;base64,%%%",
        load: async () => {
          calls++
          return library(async () => {
            throw new Error("unused")
          })
        },
      }),
    )
    await settle()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect(calls).toBe(0)
  })

  test("bounds raster memory for oversized scientific poster pages", async () => {
    const lib = library(async () => ({
      getViewport: ({ scale }) => ({ width: 100_000 * scale, height: 200_000 * scale }),
      render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    }))
    const { host } = mount(() =>
      subject.PdfViewer({ kind: "pdf", data: { url: "/poster.pdf" }, load: async () => lib }),
    )
    await settle()
    const canvas = host.querySelector("canvas")!
    expect(canvas.width).toBeLessThanOrEqual(8192)
    expect(canvas.height).toBeLessThanOrEqual(8192)
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(24 * 1024 * 1024)
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  test("shows page-loading failures and exits rendering instead of leaving an unhandled rejection", async () => {
    const lib = library(async () => {
      throw new Error("PDF page is corrupt")
    })
    const { host } = mount(() => subject.PdfViewer({ kind: "pdf", data: { url: "/first.pdf" }, load: async () => lib }))
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("PDF page is corrupt")
    expect(host.querySelector(".pdf-viewer-rendering")).toBeNull()
  })

  test("reports rasterization failures instead of marking a blank page as rendered", async () => {
    const lib = library(async () => ({
      getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
      render: () => ({ promise: Promise.reject(new Error("Canvas render failed")), cancel: () => {} }),
    }))
    const { host } = mount(() =>
      subject.PdfViewer({ kind: "pdf", data: { url: "/render.pdf" }, load: async () => lib }),
    )
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Canvas render failed")
    expect(host.querySelector(".pdf-viewer-rendering")).toBeNull()
  })

  test("does not create a PDF worker after the viewer closes during lazy loading", async () => {
    const pending = Promise.withResolvers<Library>()
    let calls = 0
    const lib: Library = {
      GlobalWorkerOptions: { workerSrc: "" },
      getDocument: () => {
        calls++
        return {
          promise: Promise.resolve({
            numPages: 0,
            getPage: async () => {
              throw new Error("unused")
            },
          }),
          destroy: async () => {},
        }
      },
    }
    const { dispose } = mount(() =>
      subject.PdfViewer({ kind: "pdf", data: { url: "/late.pdf" }, load: () => pending.promise }),
    )
    await settle()
    dispose()
    pending.resolve(lib)
    await settle()
    expect(calls).toBe(0)
  })

  test("replaces the document on source changes and preserves bytes owned by the caller", async () => {
    const first = new Uint8Array([1, 2, 3])
    const [data, setData] = solidjs.createSignal({ bytes: first })
    const received: Uint8Array[] = []
    let destroyed = 0
    const lib: Library = {
      GlobalWorkerOptions: { workerSrc: "" },
      getDocument: (src) => {
        received.push(src.data as Uint8Array)
        return {
          promise: Promise.resolve({
            numPages: 0,
            getPage: async () => {
              throw new Error("unused")
            },
          }),
          destroy: async () => {
            destroyed++
          },
        }
      },
    }
    mount(() =>
      subject.PdfViewer({
        kind: "pdf",
        get data() {
          return data()
        },
        load: async () => lib,
      }),
    )
    await settle()
    expect(received).toHaveLength(1)
    expect(received[0]).not.toBe(first)
    expect(received[0].buffer).not.toBe(first.buffer)
    setData({ bytes: new Uint8Array([4, 5, 6]) })
    await settle()
    expect(destroyed).toBe(1)
    expect(received).toHaveLength(2)
    expect([...received[1]]).toEqual([4, 5, 6])
    expect([...first]).toEqual([1, 2, 3])
  })
})
