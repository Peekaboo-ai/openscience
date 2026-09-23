import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"
import { entry, page } from "./fixtures"
import type { Snapshot } from "./controller"
import type { TimelineWorkbench } from "@synsci/sdk/v2/client"

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
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await server.ssrLoadModule("/src/atlas/timeline/TimelineView.tsx")) as typeof import("./TimelineView")
const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})
afterAll(() => server.close())
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function mount(
  entries = [entry("msg_a"), entry("msg_b", { title: "R analysis", status: "error" })],
  options: Partial<import("./TimelineView").TimelineViewProps> = {},
) {
  const host = document.createElement("div")
  document.body.append(host)
  const data: Snapshot = {
    pages: [page(entries.map((item) => item.id))],
    entries,
    loading: false,
    error: "",
    workbenchError: "",
  }
  cleanups.push(
    web.render(
      () =>
        subject.TimelineView({
          sessionID: "ses_a",
          data,
          t: (en) => en,
          refresh: () => {},
          earlier: async () => {},
          checkpoint: () => {},
          fork: () => {},
          openSession: () => {},
          openCheckpoint: () => {},
          restart: () => {},
          revert: () => {},
          restore: () => {},
          ...options,
        }),
      host,
    ),
  )
  return host
}

test("renders real statuses, opens details, and searches with temporary turn expansion", async () => {
  const host = mount()
  await settle()
  expect(host.querySelector(".action-timeline__ledger")?.textContent).toContain("Failed")
  host.querySelector<HTMLButtonElement>(".action-timeline__entry")!.click()
  await settle()
  expect(host.querySelector('[aria-label="Action details"]')?.textContent).toContain("msg_a")
  host.querySelector<HTMLButtonElement>(".action-timeline__turn")!.click()
  await settle()
  expect(host.querySelectorAll(".action-timeline__entry")).toHaveLength(0)
  const search = host.querySelector<HTMLInputElement>('input[type="search"]')!
  search.value = "Python"
  search.dispatchEvent(new Event("input", { bubbles: true }))
  await settle()
  expect(host.querySelectorAll(".action-timeline__entry")).toHaveLength(1)
  search.value = ""
  search.dispatchEvent(new Event("input", { bubbles: true }))
  await settle()
  expect(host.querySelectorAll(".action-timeline__entry")).toHaveLength(0)
})

test("large history uses a bounded DOM and zoom controls work without a pointer gesture", async () => {
  const host = mount(Array.from({ length: 2000 }, (_, index) => entry(`msg_${index}`, { turnID: `turn_${index}` })))
  await settle()
  expect(host.querySelectorAll(".action-timeline__row").length).toBeLessThan(40)
  const before = host.querySelector("time")!.getAttribute("title")
  host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click()
  await settle()
  expect(host.querySelector("time")!.getAttribute("title")).not.toBe(before)
  expect(host.querySelectorAll('[aria-label="Action ledger"]').length).toBe(1)
})

test("Chinese ledger hides internal IDs, searches provider labels, and exposes diagnostics only in details", async () => {
  const host = mount(
    [
      entry("request_internal", { kind: "user", title: "比较处理组与对照组的差异表达" }),
      entry("model_internal", { provider: "custom-private-uuid", model: "research-model", status: "error" }),
      entry("tool_internal", { kind: "tool", tool: "skill" }),
    ],
    {
      t: (_en, zh) => zh,
      catalog: [{ id: "custom-private-uuid", name: "科研网关", models: { "research-model": { name: "研究模型" } } }],
    },
  )
  await settle()
  const ledger = host.querySelector(".action-timeline__ledger")!
  expect(ledger.textContent).toContain("比较处理组与对照组")
  expect(ledger.textContent).toContain("研究模型 · 科研网关")
  expect(ledger.textContent).toContain("加载研究技能")
  expect(ledger.textContent).not.toContain("custom-private-uuid")
  expect(ledger.textContent).not.toContain("TURN")
  const search = host.querySelector<HTMLInputElement>('input[type="search"]')!
  search.value = "科研网关"
  search.dispatchEvent(new Event("input", { bubbles: true }))
  await settle()
  expect(host.querySelectorAll(".action-timeline__entry")).toHaveLength(1)
  host.querySelector<HTMLButtonElement>(".action-timeline__entry")!.click()
  await settle()
  const details = host.querySelector('[aria-label="行动详情"]')!
  expect(details.textContent).toContain("本次模型请求失败")
  const diagnostics = [...details.querySelectorAll("details")].find((item) => item.textContent?.includes("技术标识"))!
  expect(diagnostics.open).toBe(false)
  expect(diagnostics.textContent).toContain("custom-private-uuid")
})

test("review filter retains request context and keyboard navigation focuses actual steps", async () => {
  const host = mount([
    entry("request", { kind: "user", title: "Analyze samples" }),
    entry("ok"),
    entry("failed", { status: "error" }),
  ])
  await settle()
  ;[...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "Needs review")!.click()
  await settle()
  expect(host.querySelectorAll(".action-timeline__entry")).toHaveLength(1)
  expect(host.querySelector(".action-timeline__turn")?.textContent).toContain("Analyze samples")
  expect(host.querySelector(".action-timeline__entry")?.textContent).toContain("Step 2")
  host
    .querySelector(".action-timeline__ledger")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
  await settle()
  expect(document.activeElement?.classList.contains("action-timeline__entry")).toBe(true)
})

test("workbench binds checkpoint, recovery and exact run controls to their displayed identities", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const workbench: TimelineWorkbench = {
    sessionID: "ses_a",
    status: "idle",
    branches: [],
    recoveries: [],
    runs: [{ id: "run_exact", status: "running", acceptedAt: 1 }],
    executions: [],
    checkpoints: [
      { id: "checkpoint_exact", sessionID: "ses_a", createdAt: 1, path: "checkpoint.md", summary: "saved state" },
    ],
    children: [],
    jobs: [],
    kernels: [],
    permissions: { pending: 0, total: 0, rejected: 0 },
    context: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, compactions: 0 },
    capabilities: { conversationFork: true, fileCheckpoint: true, kernelRestore: true },
  }
  const data: Snapshot = { pages: [page([])], entries: [], workbench, loading: false, error: "", workbenchError: "" }
  const calls: string[] = []
  cleanups.push(
    web.render(
      () =>
        subject.TimelineView({
          sessionID: "ses_a",
          data,
          t: (en) => en,
          refresh: () => {},
          earlier: async () => {},
          checkpoint: () => {},
          fork: () => {},
          openSession: () => {},
          openCheckpoint: () => {},
          restart: () => {},
          revert: () => {},
          restore: () => {},
          cancelRun: (id) => calls.push(id),
          previewRecovery: (id) => calls.push(id),
          recoveryPlan: { checkpointID: "checkpoint_exact", steps: [], safe: 0, manual: 1 },
          recover: (id) => calls.push(`recover:${id}`),
        }),
      host,
    ),
  )
  await settle()
  const click = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!.click()
  click("Cancel this run")
  click("Recovery plan")
  click("Recover to new branch")
  expect(calls).toEqual(["run_exact", "checkpoint_exact", "recover:checkpoint_exact"])
  expect(host.textContent).toContain("1 manual steps")
})
