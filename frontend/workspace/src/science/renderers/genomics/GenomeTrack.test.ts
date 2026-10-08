import { afterAll, afterEach, expect, test } from "bun:test"
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
  "/src/science/renderers/genomics/GenomeTrack.tsx",
)) as typeof import("./GenomeTrack")
const solidjs = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const stores = (await server.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
type Library = Awaited<ReturnType<NonNullable<Parameters<typeof subject.GenomeTrack>[0]["load"]>>>
const cleanups: Array<() => void> = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(view, host)
  cleanups.push(dispose)
  return { host, dispose }
}
afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("in-place store updates refresh locus and nested reference and track configuration", async () => {
  const [state, setState] = stores.createStore({
    data: {
      reference: { fastaURL: "/first.fa" },
      locus: "MYC",
      tracks: [{ name: "variants", url: "/first.vcf" }],
    },
  })
  const original = state.data
  const created: Record<string, unknown>[] = []
  const removed: unknown[] = []
  const library: Library = {
    createBrowser: async (_host, options) => {
      created.push(options)
      return options
    },
    removeBrowser: (browser) => {
      removed.push(browser)
    },
  }
  mount(() =>
    subject.GenomeTrack({
      kind: "genome-track",
      get data() {
        return state.data
      },
      load: async () => library,
    }),
  )
  await settle()
  setState("data", { locus: "TP53" })
  await settle()
  setState("data", "reference", "fastaURL", "/second.fa")
  await settle()
  setState("data", "tracks", 0, "url", "/second.vcf")
  await settle()
  expect(state.data).toBe(original)
  expect(created).toHaveLength(4)
  expect(created[0]).toMatchObject({
    reference: { fastaURL: "/first.fa" },
    locus: "MYC",
    tracks: [{ url: "/first.vcf" }],
  })
  expect(created[3]).toMatchObject({
    reference: { fastaURL: "/second.fa" },
    locus: "TP53",
    tracks: [{ url: "/second.vcf" }],
  })
  expect(removed).toEqual(created.slice(0, 3))
})

test("changed genome data replaces the browser and removes the old reference", async () => {
  const [data, setData] = solidjs.createSignal({ genome: "hg38", locus: "MYC" })
  const created: unknown[] = []
  const removed: unknown[] = []
  const library: Library = {
    createBrowser: async (_host, options) => {
      created.push(options)
      return options
    },
    removeBrowser: (browser) => {
      removed.push(browser)
    },
  }
  mount(() =>
    subject.GenomeTrack({
      kind: "genome-track",
      get data() {
        return data()
      },
      load: async () => library,
    }),
  )
  await settle()
  setData({ genome: "mm39", locus: "Trp53" })
  await settle()
  expect(created).toHaveLength(2)
  expect(created[1]).toMatchObject({ genome: "mm39", locus: "Trp53" })
  expect(removed).toEqual([created[0]])
})

test("a closed viewer never initializes a late-loaded genome library", async () => {
  const pending = Promise.withResolvers<Library>()
  let created = 0
  const { dispose } = mount(() =>
    subject.GenomeTrack({ kind: "genome-track", data: { genome: "hg38" }, load: () => pending.promise }),
  )
  await settle()
  dispose()
  pending.resolve({
    createBrowser: async () => {
      created++
      return {}
    },
    removeBrowser: () => {},
  })
  await settle()
  expect(created).toBe(0)
})

test("late browser creation is disposed after the viewer closes", async () => {
  const pending = Promise.withResolvers<unknown>()
  const removed: unknown[] = []
  const { dispose } = mount(() =>
    subject.GenomeTrack({
      kind: "genome-track",
      data: { genome: "hg38" },
      load: async () => ({
        createBrowser: () => pending.promise,
        removeBrowser: (browser) => {
          removed.push(browser)
        },
      }),
    }),
  )
  await settle()
  dispose()
  const old = { id: "old" }
  pending.resolve(old)
  await settle()
  expect(removed).toEqual([old])
})
