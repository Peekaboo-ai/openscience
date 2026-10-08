import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import type { ExperimentRun, Study, StudyOverview } from "@synsci/sdk/v2/client"
import { createTestServer } from "../../test/vite"

const vite = await createTestServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const stores = (await vite.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const subject = (await vite.ssrLoadModule("/src/atlas/AutoresearchPane.tsx")) as typeof import("./AutoresearchPane")
const cleanups: (() => void)[] = []

const study = (id: string): Study => ({
  id,
  projectID: "project",
  sessionID: "session",
  name: `Study ${id}`,
  purpose: "Measure reproducible results",
  metric: "accuracy",
  direction: "maximize",
  status: "running",
  root: `/research/${id}`,
  target: { kind: "local" },
  concurrency: 1,
  killCriteria: "",
  budget: {},
  review: false,
  turns: 0,
  costUSD: 0,
  lessons: "",
  directives: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
})
const overview = (id: string, headline: number): StudyOverview => {
  const run: ExperimentRun = {
    id: `run-${id}`,
    projectID: "project",
    studyID: id,
    name: `Baseline ${id}`,
    status: "finished",
    source: "external",
    config: {},
    summary: {},
    headline,
    baselineDelta: null,
    points: 0,
    lastStep: null,
    slot: null,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
  }
  return { study: study(id), runs: [run], ideas: [], events: [], baseline: run, best: run }
}
const ready = async (check: () => boolean) => {
  for (let index = 0; index < 150 && !check(); index++) await Bun.sleep(10)
  expect(check()).toBe(true)
}
function mount() {
  const [scope, setScope] = stores.createStore({ id: "project-one" })
  const state = {
    reads: [] as string[],
    writes: [] as { path: string; body?: string }[],
    write: async (): Promise<Response> => Response.json({}),
    read: async (path: string, _query?: Record<string, string>): Promise<Response> => {
      if (path === "/experiments/studies") return Response.json([study("A"), study("B")])
      if (path.startsWith("/experiments/studies/"))
        return Response.json(overview(path.endsWith("A") ? "A" : "B", path.endsWith("A") ? 55 : 88))
      return Response.json([])
    },
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(
    () =>
      subject.AutoresearchPane({
        services: {
          get scope() {
            return scope.id
          },
          request: (path, init, query) => {
            if (init?.method === "POST") {
              state.writes.push({ path, body: init.body as string | undefined })
              return state.write()
            }
            state.reads.push(path)
            return state.read(path, query)
          },
          event: { on: () => () => {} },
        },
      }),
    host,
  )
  cleanups.push(dispose)
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!
  const input = () => host.querySelector<HTMLInputElement>('[aria-label="Directive"],input')!
  const draft = (text: string) => {
    input().value = text
    input().dispatchEvent(new Event("input", { bubbles: true }))
  }
  return { host, state, button, input, draft, changeScope: () => setScope("id", "project-two") }
}

afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

test("chart visibility buttons keep keyboard activation separate from run expansion", async () => {
  const f = mount()
  await ready(() => !!f.host.querySelector(".ar-run__swatch"))
  const swatch = f.host.querySelector<HTMLButtonElement>(".ar-run__swatch")!
  const row = swatch.closest<HTMLElement>(".ar-run__row")!
  for (const key of ["Enter", " "]) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    swatch.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(row.getAttribute("aria-expanded")).toBe("false")
  }
  const selected = swatch.getAttribute("aria-pressed")
  swatch.click()
  expect(swatch.getAttribute("aria-pressed")).not.toBe(selected)
  expect(row.getAttribute("aria-expanded")).toBe("false")
  row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  expect(row.getAttribute("aria-expanded")).toBe("true")
})

test("failed steering preserves its draft, reports failure, and prevents overlapping submissions", async () => {
  const f = mount()
  await ready(() => !!f.button("Steer"))
  f.button("Steer").click()
  f.draft("Only vary the optimizer")
  const response = Promise.withResolvers<Response>()
  f.state.write = () => response.promise
  f.button("Send").click()
  f.button("Send").click()
  await ready(() => f.state.writes.length === 1)
  expect(f.state.writes).toHaveLength(1)
  expect(f.button("Pause").disabled).toBe(true)
  response.resolve(Response.json({ error: "offline" }, { status: 503 }))
  await ready(() => !!f.host.querySelector('[role="alert"]'))
  expect(f.input().value).toBe("Only vary the optimizer")
  expect(f.button("Send").disabled).toBe(false)
  expect(f.host.textContent).toContain("503")
})

test("study controls expose transport errors and become available to retry", async () => {
  const f = mount()
  await ready(() => !!f.button("Pause"))
  f.state.write = async () => {
    throw new Error("Connection interrupted")
  }
  f.button("Pause").click()
  await ready(() => !!f.host.querySelector('[role="alert"]'))
  expect(f.host.textContent).toContain("Connection interrupted")
  expect(f.button("Pause").disabled).toBe(false)
  expect(f.host.querySelector('[data-status="paused"]')).toBeNull()
})

test("late directive completion and overview data stay with their original study", async () => {
  const f = mount()
  await ready(() => Number(f.host.querySelector(".ar-score__value strong")?.textContent) === 55)
  f.button("Steer").click()
  f.draft("Directive for A")
  const sent = Promise.withResolvers<Response>()
  const nextOverview = Promise.withResolvers<Response>()
  const original = f.state.read
  f.state.write = () => sent.promise
  f.state.read = (path) => (path === "/experiments/studies/B" ? nextOverview.promise : original(path))
  f.button("Send").click()
  f.button("Study B").click()
  expect(f.host.querySelector(".ar-score__value strong")?.textContent).toBe("—")
  f.button("Steer").click()
  f.draft("Directive for B")
  sent.resolve(Response.json({}))
  await Bun.sleep(20)
  expect(f.input().value).toBe("Directive for B")
  expect(f.state.writes[0]).toMatchObject({ path: "/experiments/studies/A/directives" })
  nextOverview.resolve(Response.json(overview("B", 88)))
  await ready(() => Number(f.host.querySelector(".ar-score__value strong")?.textContent) === 88)
})

test("failed research reads show a retry state instead of crashing the pane", async () => {
  const f = mount()
  await ready(() => !!f.button("Study A"))
  const original = f.state.read
  f.state.read = async () => Response.json({ error: "offline" }, { status: 503 })
  f.button("Pause").click()
  await ready(() => !!f.button("Retry"))
  expect(f.button("Study A")).toBeDefined()
  f.state.read = original
  f.button("Retry").click()
  await ready(() => !f.button("Retry"))
  expect(Number(f.host.querySelector(".ar-score__value strong")?.textContent)).toBe(55)
})

test("switching projects releases the old pane and isolates late updates and drafts", async () => {
  const f = mount()
  await ready(() => !!f.button("Steer"))
  f.button("Steer").click()
  f.draft("Only for the previous project")
  const response = Promise.withResolvers<Response>()
  f.state.write = () => response.promise
  f.button("Send").click()
  await ready(() => f.state.writes.length === 1)
  const previous = f.host.querySelector(".ar-score")
  f.changeScope()
  await ready(() => f.host.querySelector(".ar-score") !== previous && !!f.button("Steer"))
  response.resolve(Response.json({ error: "Old request failed" }, { status: 503 }))
  f.button("Steer").click()
  await Bun.sleep(20)
  expect(f.input().value).toBe("")
  expect(f.host.querySelector('[role="alert"]')).toBeNull()
  expect(f.button("Pause").disabled).toBe(false)
})

test("changing metrics or studies never relabels previously loaded curves and metric options", async () => {
  const f = mount()
  const original = f.state.read
  const loss = Promise.withResolvers<Response>()
  const nextKeys = Promise.withResolvers<Response>()
  let lossRequested = false
  let nextKeysRequested = false
  f.state.read = (path, query) => {
    if (path === "/experiments/keys") {
      if (query?.run_ids === "run-B") {
        nextKeysRequested = true
        return nextKeys.promise
      }
      return Promise.resolve(Response.json(["accuracy", "loss"]))
    }
    if (path === "/experiments/series") {
      if (query?.keys === "loss") {
        lossRequested = true
        return loss.promise
      }
      return Promise.resolve(
        Response.json([
          {
            runID: "run-A",
            key: "accuracy",
            points: [
              { step: 0, value: 0.5 },
              { step: 1, value: 0.8 },
            ],
          },
        ]),
      )
    }
    return original(path, query)
  }
  await ready(() => !!f.button("Curves") && !f.button("Curves").disabled)
  f.button("Curves").click()
  await ready(() => !!f.host.querySelector(".ar-curves .metric-chart__line"))
  const metric = () => f.host.querySelector<HTMLSelectElement>('select[aria-label="Metric"]')!
  expect(metric().value).toBe("accuracy")
  metric().value = "loss"
  metric().dispatchEvent(new Event("change", { bubbles: true }))
  await ready(() => lossRequested)
  expect(f.host.querySelector(".ar-curves .metric-chart__line")).toBeNull()
  expect(f.host.querySelector(".ar-curves")?.textContent).toContain("No points yet")
  loss.resolve(Response.json({ error: "offline" }, { status: 503 }))
  await ready(() => !!f.host.querySelector('[role="alert"]'))
  expect(metric().value).toBe("loss")
  expect(f.host.querySelector(".ar-curves .metric-chart__line")).toBeNull()
  f.button("Study B").click()
  await ready(() => nextKeysRequested)
  expect(metric().options).toHaveLength(0)
  expect(f.host.querySelector(".ar-curves .metric-chart__line")).toBeNull()
  nextKeys.resolve(Response.json(["precision"]))
  await ready(() => [...metric().options].some((item) => item.value === "precision"))
  expect([...metric().options].map((item) => item.value)).toEqual(["precision"])
})
