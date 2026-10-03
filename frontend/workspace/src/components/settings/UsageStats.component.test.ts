import { afterAll, afterEach, expect, test } from "bun:test"
import { once } from "node:events"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"
import type { UsageReport } from "./usage-stats"
import { usageCSV } from "./usage-stats"

const vite = await createTestServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await vite.ssrLoadModule("/src/components/settings/UsageStats.tsx")) as typeof import("./UsageStats")
const stores = (await vite.ssrLoadModule("solid-js/store")) as typeof import("solid-js/store")
const cleanups: (() => void)[] = []
const ready = async (check: () => boolean) => {
  for (let index = 0; index < 150 && !check(); index++) await Bun.sleep(20)
  expect(check()).toBe(true)
}

function fixture(range: UsageReport["range"], empty: boolean, count = 1): UsageReport {
  const tokens = {
    input: empty ? 0 : range === "7d" ? 600 : 2_400,
    output: empty ? 0 : 100,
    reasoning: 20,
    cacheRead: empty ? 0 : 300,
    cacheWrite: 0,
  }
  const total = tokens.input + tokens.output + tokens.cacheRead
  const totals = { tokens, total, requests: empty ? 0 : 1, sessions: empty ? 0 : 1, unreported: 0, background: 0 }
  const group = {
    ...totals,
    id: "model",
    label: "Research model",
    secondary: "gateway",
    lastUsed: Date.now(),
    available: true,
  }
  return {
    generatedAt: Date.now(),
    range,
    timeZone: "UTC",
    from: range === "7d" ? "2026-09-24" : "2026-09-01",
    to: "2026-09-30",
    firstRecord: empty ? null : "2026-09-30",
    totals,
    previous: null,
    cacheHitRate: empty ? 0 : 0.1,
    activeDays: empty ? 0 : 1,
    peakDay: null,
    models: empty
      ? []
      : Array.from({ length: count }, (_, index) => ({
          ...group,
          id: `model-${index}`,
          label: `Research model ${index}`,
          providerID: "gateway",
          modelID: `model-${index}`,
        })),
    projects: empty ? [] : [{ ...group, id: "prj_bio", label: "Bio", secondary: "prj_bio", projectID: "prj_bio" }],
    sessions: empty
      ? []
      : [{ ...group, id: "ses_research", label: "Docking results", secondary: "Bio", projectID: "prj_bio" }],
    trend: [{ date: "2026-09-30", end: "2026-09-30", tokens, total, requests: totals.requests }],
    interval: "day",
    activity: [{ date: "2026-09-30", total, requests: totals.requests, level: empty ? 0 : 4 }],
    options: {
      projects: [{ id: "prj_bio", label: "Bio" }],
      providers: ["gateway"],
      models: [{ id: "model-0", label: "Research model 0", providerID: "gateway" }],
    },
    quality: { historical: 0, skipped: 0, inherited: 0 },
  }
}

async function mount(options: { empty?: boolean; count?: number; slow?: boolean; slowCustom?: boolean } = {}) {
  const state = {
    calls: [] as URLSearchParams[],
    reject: false,
    empty: options.empty ?? false,
    opened: [] as string[][],
  }
  const server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*")
    response.setHeader("access-control-allow-headers", "content-type")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const params = new URL(request.url!, "http://localhost").searchParams
    state.calls.push(params)
    if (options.slow && params.get("range") === "7d") await Bun.sleep(300)
    if (options.slowCustom && params.get("range") === "custom") await Bun.sleep(300)
    response.writeHead(state.reject ? 503 : 200, { "content-type": "application/json" })
    response.end(
      JSON.stringify(
        state.reject
          ? { message: "Server unavailable" }
          : fixture(params.get("range") as UsageReport["range"], state.empty, options.count),
      ),
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a loopback listener")
  const host = document.createElement("div")
  document.body.append(host)
  const [sdk, setSDK] = stores.createStore({ url: `http://127.0.0.1:${address.port}` })
  const dispose = web.render(
    () =>
      subject.UsageStats({
        services: {
          sdk,
          platform: { fetch },
          label: "Bio server",
          providers: { gateway: "Research gateway" },
          openSession: (projectID, sessionID) => state.opened.push([projectID, sessionID]),
        },
      }),
    host,
  )
  cleanups.push(() => {
    dispose()
    server.closeAllConnections()
    server.close()
  })
  await ready(() => host.querySelector('[aria-label="Refresh usage"]')?.hasAttribute("disabled") === false)
  const button = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name)!
  return { host, state, button, changeServer: () => setSDK("url", `${sdk.url}/other-server`) }
}

afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("renders token summaries and switches periods without pricing", async () => {
  const { host, state, button } = await mount()
  expect(host.textContent).toContain("Bio server")
  expect(host.querySelector('.usage-metric__value[title="2,800"]')).not.toBeNull()
  expect(host.textContent).toContain("Input tokens")
  expect(host.textContent).toContain("Output tokens")
  expect(host.querySelector(".usage-source__secondary")?.textContent).toBe("Research gateway")
  expect(host.textContent).not.toMatch(/cost|price|USD/i)
  button("7 days").click()
  await ready(
    () =>
      state.calls.at(-1)?.get("range") === "7d" && host.querySelector('.usage-metric__value[title="1,000"]') !== null,
  )
  expect(state.calls.at(-1)?.get("timeZone")).toBeTruthy()
})

test("search, pagination, disclosure and session navigation use the selected breakdown", async () => {
  const { host, state, button } = await mount({ count: 10 })
  expect(host.querySelectorAll("tbody > tr")).toHaveLength(8)
  host.querySelector<HTMLButtonElement>('[aria-label="Next usage page"]')!.click()
  expect(host.querySelectorAll("tbody > tr")).toHaveLength(2)
  const search = host.querySelector<HTMLInputElement>('[aria-label="Search usage models"]')!
  search.value = "model 9"
  search.dispatchEvent(new Event("input", { bubbles: true }))
  expect(host.querySelectorAll("tbody > tr")).toHaveLength(1)
  button("Sessions").click()
  button("Docking results").click()
  expect(host.querySelector(".usage-table__detail")?.textContent).toContain("Reasoning (in output)")
  host.querySelector<HTMLButtonElement>('[aria-label="Open session Docking results"]')!.click()
  expect(state.opened).toEqual([["prj_bio", "ses_research"]])
})

test("a failed refresh preserves the report and retry recovers", async () => {
  const { host, state } = await mount()
  const refresh = host.querySelector<HTMLButtonElement>('[aria-label="Refresh usage"]')!
  state.reject = true
  refresh.click()
  await ready(() => host.querySelector('[role="alert"]') !== null)
  expect(host.querySelector(".usage-metrics")).not.toBeNull()
  expect(host.textContent).toContain("Check the connection")
  state.reject = false
  refresh.click()
  await ready(() => host.querySelector('[role="alert"]') === null && !refresh.disabled)
})

test("switching servers clears the previous server's report even if the next request fails", async () => {
  const { host, state, changeServer } = await mount()
  state.reject = true
  changeServer()
  await ready(() => host.querySelector('[role="alert"]') !== null)
  expect(host.querySelector(".usage-metrics")).toBeNull()
})

test("custom dates continue the currently selected period", async () => {
  const { host, state, button } = await mount()
  button("7 days").click()
  await ready(
    () => state.calls.at(-1)?.get("range") === "7d" && host.querySelector('.usage-content[aria-busy="false"]') !== null,
  )
  button("Custom").click()
  await ready(() => state.calls.at(-1)?.get("range") === "custom")
  expect(host.querySelector<HTMLInputElement>('[aria-label="Usage start date"]')!.value).toBe("2026-09-24")
  expect(state.calls.at(-1)?.get("from")).toBe("2026-09-24")
})

test("empty data has a clear empty state and no misleading export action", async () => {
  const { host } = await mount({ empty: true })
  expect(host.textContent).toContain("No usage in this period")
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Export usage CSV"]')?.disabled).toBe(true)
  expect(host.querySelector(".usage-chart")).toBeNull()
})

test("CSV preserves exact token counts and selected rows without pricing fields", () => {
  const report = fixture("30d", false, 10)
  const csv = usageCSV(report, "models", [report.models[9]])
  expect(csv).toStartWith("\uFEFF")
  expect(csv).toContain('"Research model 9"')
  expect(csv).not.toContain('"Research model 0"')
  expect(csv).toContain('"2800","2400","100","20","300","0"')
  expect(csv).not.toMatch(/cost|price|USD/i)
})

test("a late response from an old filter cannot overwrite the newest period", async () => {
  const { host, state, button } = await mount({ slow: true })
  button("7 days").click()
  await ready(() => state.calls.at(-1)?.get("range") === "7d")
  button("90 days").click()
  await ready(
    () =>
      state.calls.at(-1)?.get("range") === "90d" && host.querySelector('.usage-content[aria-busy="false"]') !== null,
  )
  await Bun.sleep(350)
  expect(button("90 days").getAttribute("aria-pressed")).toBe("true")
  expect(host.querySelector('.usage-metric__value[title="2,800"]')).not.toBeNull()
})

test("invalid date edits cancel pending reports and restore nonloading controls", async () => {
  const { host, state, button } = await mount({ slowCustom: true })
  state.empty = true
  button("Custom").click()
  await ready(() => state.calls.at(-1)?.get("range") === "custom")
  const date = host.querySelector<HTMLInputElement>('[aria-label="Usage start date"]')!
  date.value = ""
  date.dispatchEvent(new Event("change", { bubbles: true }))
  expect(host.querySelector('.usage-content[aria-busy="false"]')).not.toBeNull()
  expect(host.textContent).toContain("Choose a valid date range")
  await Bun.sleep(350)
  expect(host.querySelector('.usage-metric__value[title="2,800"]')).not.toBeNull()
  expect(host.textContent).not.toContain("No usage in this period")
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Export usage CSV"]')?.disabled).toBe(true)
})

test("changing backend while custom dates are invalid never displays another backend's report", async () => {
  const { host, button, changeServer } = await mount()
  button("Custom").click()
  const date = host.querySelector<HTMLInputElement>('[aria-label="Usage start date"]')!
  date.value = ""
  date.dispatchEvent(new Event("change", { bubbles: true }))
  changeServer()
  expect(host.querySelector(".usage-metrics")).toBeNull()
  expect(host.querySelector('[aria-label="Loading usage statistics"]')).toBeNull()
  expect(host.textContent).toContain("Choose a valid date range")
})
