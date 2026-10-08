import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../test/vite"
import type { MonitorReport } from "./compute-monitor"
import type { MonitorRequest } from "./ResourceMonitor"

const server = await createTestServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/ResourceMonitor.fixture.tsx") as Promise<typeof import("./ResourceMonitor.fixture")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: (() => void)[] = []
afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})
const ready = async (check: () => boolean) => {
  for (let index = 0; index < 100 && !check(); index++) await Bun.sleep(10)
  expect(check()).toBe(true)
}
const report = (time = 100_000): MonitorReport => ({
  selected: "slurm:41",
  targets: [
    { id: "host", label: "Login node", kind: "host", state: "running" },
    { id: "slurm:41", label: "Training · Slurm 41", kind: "slurm", state: "running" },
  ],
  state: "live",
  nodes: ["n1", "n2"],
  node: "n1",
  issues: [],
  intervalMs: 5000,
  sample: {
    sampledAt: time,
    hostname: "n1",
    acceleratorScope: { kind: "allocation", jobID: "41", expectedDevices: 1 },
    cpu: { cores: 128, utilization: 32 },
    memory: { used: 32 * 1024 ** 3, total: 128 * 1024 ** 3 },
    issues: [],
    devices: [
      {
        id: "hy-smi:0",
        name: "DCU 0",
        source: "hy-smi",
        kind: "DCU",
        utilization: 85,
        memoryUsed: 8 * 1024 ** 3,
        memoryTotal: 32 * 1024 ** 3,
        memoryPercent: 25,
        temperature: 51,
        power: 160,
      },
    ],
  },
})
const refresh = () => document.dispatchEvent(new Event("visibilitychange"))
function mount(request: MonitorRequest) {
  const host = document.createElement("div")
  document.body.append(host)
  let changeSession: (value: string) => void = () => {}
  let changeVisibility: (value: boolean) => void = () => {}
  const dispose = web.render(
    () =>
      web.createComponent(subject.MonitorFixture, {
        request,
        control: (change) => {
          changeSession = change
        },
        visibility: (change) => {
          changeVisibility = change
        },
      }),
    host,
  )
  cleanups.push(dispose)
  return { host, dispose, changeSession, changeVisibility }
}

test.each(["headers", "body"])("a stalled %s read times out, recovers and ignores its late sample", async (phase) => {
  const timeout = globalThis.setTimeout
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => timeout(callback, delay === 30_000 ? 30 : delay, ...args)) as typeof setTimeout)
  const stalled = Promise.withResolvers<unknown>()
  let attempts = 0
  let signal: AbortSignal | null | undefined
  try {
    const { host } = mount(async (_, init) => {
      signal = init?.signal
      attempts++
      if (attempts > 1) {
        const next = report(105_000)
        next.sample!.cpu.utilization = 61
        return Response.json(next)
      }
      if (phase === "headers") return stalled.promise as Promise<Response>
      return { ok: true, json: () => stalled.promise } as Response
    })
    await ready(() => host.querySelector(".resource-monitor")?.getAttribute("data-state") === "unavailable")
    expect(signal?.aborted).toBe(true)
    expect(host.textContent).toContain("too long")
    refresh()
    await ready(() => host.querySelector(".resource-monitor")?.getAttribute("data-state") === "live")
    expect(host.textContent).toContain("61.0%")
    stalled.resolve(phase === "headers" ? Response.json(report()) : report())
    await Bun.sleep(20)
    expect(host.textContent).toContain("61.0%")
    expect(attempts).toBe(2)
  } finally {
    timer.mockRestore()
  }
})

test("renders device metrics and preserves chart focus across fresh samples", async () => {
  let time = 100_000
  const { host } = mount(async () => Response.json(report((time += 5000))))
  await ready(() => host.textContent?.includes("85.0%") ?? false)
  const chart = host.querySelector('[aria-label^="DCU 0 compute"]')!
  refresh()
  await Bun.sleep(30)
  expect(host.querySelector('[aria-label^="DCU 0 compute"]')).toBe(chart)
  expect(host.textContent).toContain("8.0 / 32.0 GiB")
  expect(host.textContent).toContain("Allocated accelerators · 1")
  expect(host.textContent).toContain("CPU and system memory cover the entire node")
  expect(host.querySelectorAll("svg")).toHaveLength(3)
})

test("allocation uncertainty hides node-wide devices while preserving CPU and memory monitoring", async () => {
  const result = report()
  result.sample!.acceleratorScope = {
    kind: "unavailable",
    jobID: "41",
    reason: "Device allocation could not be verified.",
  }
  const { host } = mount(async () => Response.json(result))
  await ready(() => host.textContent?.includes("Device allocation could not be verified") ?? false)
  expect(host.querySelectorAll(".resource-monitor__devices article")).toHaveLength(0)
  expect(host.querySelectorAll("svg")).toHaveLength(2)
  expect(host.textContent).toContain("32.0%")
  expect(host.textContent).not.toContain("85.0%")
})

test("a CPU-only allocation is not presented as a telemetry failure", async () => {
  const result = report()
  result.sample!.acceleratorScope = { kind: "allocation", jobID: "41", expectedDevices: 0 }
  result.sample!.devices = []
  const { host } = mount(async () => Response.json(result))
  await ready(() => host.textContent?.includes("No accelerators are allocated to this job") ?? false)
  expect(host.querySelector(".resource-monitor")?.getAttribute("data-state")).toBe("live")
  expect(host.querySelectorAll("svg")).toHaveLength(2)
})

test("new device allocations do not inherit curves from an earlier allocation of the same job", async () => {
  let responses = 0
  let ids = ["0", "1", "2", "3"]
  const { host } = mount(async () => {
    const result = report(100_000 + ++responses * 5000)
    const device = result.sample!.devices[0]
    result.sample!.acceleratorScope = { kind: "allocation", jobID: "41", expectedDevices: 4 }
    result.sample!.devices = ids.map((id) => ({ ...device, id: `hy-smi:${id}`, name: `DCU ${id}` }))
    return Response.json(result)
  })
  await ready(() => host.querySelectorAll(".resource-monitor__devices article").length === 4)
  refresh()
  await ready(() => responses === 2)
  await Bun.sleep(20)
  expect(host.querySelector(".resource-chart__line")!.getAttribute("d")!.match(/L/g)).toHaveLength(1)
  ids = ["4", "5", "6", "7"]
  refresh()
  await ready(() => host.querySelector('.resource-monitor__devices article[aria-label="DCU DCU 4"]') !== null)
  expect(host.textContent).toContain("Allocated accelerators · 4")
  expect(host.querySelector('.resource-monitor__devices article[aria-label="DCU DCU 0"]')).toBeNull()
  expect(
    host.querySelector(".resource-monitor__devices .resource-chart__line")!.getAttribute("d")!.match(/L/g),
  ).toBeNull()
  expect(
    host.querySelector(".resource-monitor__host .resource-chart__line")!.getAttribute("d")!.match(/L/g),
  ).toHaveLength(2)
})

test("standalone hosts show every visible accelerator without labelling them as a job allocation", async () => {
  const result = report()
  result.selected = "host"
  result.sample!.acceleratorScope = { kind: "host" }
  const device = result.sample!.devices[0]
  result.sample!.devices = Array.from({ length: 8 }, (_, index) => ({
    ...device,
    id: `hy-smi:${index}`,
    name: `DCU ${index}`,
  }))
  const { host } = mount(async () => Response.json(result))
  await ready(() => host.querySelectorAll(".resource-monitor__devices article").length === 8)
  expect(host.textContent).toContain("Visible accelerators · 8")
  expect(host.textContent).not.toContain("Allocated accelerators")
})

test("legacy scheduler telemetry never presents every node device as allocated", async () => {
  const result = report()
  delete result.sample!.acceleratorScope
  const { host } = mount(async () => Response.json(result))
  await ready(() => host.textContent?.includes("Update this host's backend") ?? false)
  expect(host.querySelectorAll(".resource-monitor__devices article")).toHaveLength(0)
  expect(host.querySelectorAll("svg")).toHaveLength(2)
})

test("a new sample with mismatched allocation clears previous device cards but keeps node metrics live", async () => {
  let invalid = false
  const { host } = mount(async () => {
    const result = report(invalid ? 105_000 : 100_000)
    if (invalid) result.sample!.acceleratorScope!.expectedDevices = 4
    return Response.json(result)
  })
  await ready(() => host.querySelectorAll(".resource-monitor__devices article").length === 1)
  invalid = true
  refresh()
  await ready(() => host.textContent?.includes("does not match this job's verified allocation") ?? false)
  expect(host.querySelectorAll(".resource-monitor__devices article")).toHaveLength(0)
  expect(host.querySelectorAll("svg")).toHaveLength(2)
  expect(host.querySelector(".resource-monitor")?.getAttribute("data-state")).toBe("live")
})

test.each([false, true])(
  "restoring allocation preserves an unverified gap even with a cached first response: %s",
  async (cached) => {
    let responses = 0
    const { host } = mount(async () => {
      responses++
      const result = report(100_000 + (cached && responses === 4 ? 2 : responses) * 5000)
      if (responses === 3) {
        result.sample!.acceleratorScope = { kind: "unavailable", jobID: "41", reason: "Allocation is being verified." }
        result.sample!.devices = []
        result.sample!.cpu.utilization = 77
        result.sample!.memory.used = 64 * 1024 ** 3
      }
      return Response.json(result)
    })
    const curve = () => host.querySelector(".resource-monitor__devices .resource-chart__line")!.getAttribute("d")!
    await ready(() => host.querySelectorAll(".resource-monitor__devices article").length === 1)
    refresh()
    await ready(() => responses === 2)
    await Bun.sleep(20)
    expect(curve().match(/M/g)).toHaveLength(1)
    expect(curve().match(/L/g)).toHaveLength(1)
    refresh()
    await ready(() => host.textContent?.includes("Allocation is being verified") ?? false)
    expect(host.querySelectorAll(".resource-monitor__devices article")).toHaveLength(0)
    refresh()
    await ready(() => host.querySelectorAll(".resource-monitor__devices article").length === 1)
    if (cached) {
      refresh()
      await ready(() => responses === 5)
      await Bun.sleep(20)
    }
    expect(curve().match(/M/g)).toHaveLength(2)
    expect(curve().match(/L/g)).toHaveLength(1)
    const nodeCurves = [...host.querySelectorAll(".resource-monitor__host .resource-chart__line")].map((line) =>
      line.getAttribute("d")!,
    )
    for (const path of nodeCurves) {
      expect(path.match(/M/g)).toHaveLength(1)
      expect(path.match(/L/g)).toHaveLength(3)
    }
    expect(nodeCurves[0]).toContain(",27.94")
    expect(nodeCurves[1]).toContain(",49.00")
  },
)

test("finished target and removed node keep their selected identity until the user switches target", async () => {
  let finished = false
  const requests: Record<string, unknown>[] = []
  const { host } = mount(async (_, __, query) => {
    requests.push(query ?? {})
    const result = report()
    if (finished && query?.target)
      return Response.json({
        ...result,
        selected: query.target,
        targets: [result.targets[0]],
        nodes: [],
        node: undefined,
        state: "finished",
        sample: null,
      })
    if (finished)
      return Response.json({
        ...result,
        selected: "host",
        node: "login",
        nodes: ["login"],
        sample: null,
        state: "unavailable",
        targets: [result.targets[0]],
      })
    return Response.json({ ...result, selected: query?.target ?? result.selected, node: query?.node ?? "n1" })
  })
  await ready(() => host.querySelectorAll(".resource-monitor__devices article").length === 1)
  const node = host.querySelector<HTMLSelectElement>('[aria-label="Compute node"]')!
  node.value = "n2"
  node.dispatchEvent(new Event("change", { bubbles: true }))
  await ready(() => requests.length === 2)
  await Bun.sleep(20)
  finished = true
  refresh()
  await ready(() => host.querySelector(".resource-monitor")?.getAttribute("data-state") === "finished")
  const target = host.querySelector<HTMLSelectElement>('[aria-label="Compute target"]')!
  expect(target.value).toBe("slurm:41")
  expect(target.selectedOptions[0].disabled).toBe(true)
  expect(target.selectedOptions[0].textContent).toContain("Training · Slurm 41 · finished")
  expect(host.querySelector(".resource-monitor__context")?.textContent).toContain("Training · Slurm 41")
  expect(host.textContent).toContain("This job has finished.")
  expect(host.textContent).toContain("Showing the last successful sample")
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Compute node"]')!.value).toBe("n2")
  expect(host.querySelectorAll(".resource-monitor__devices article")).toHaveLength(1)
  for (let index = 0; index < 3; index++) {
    refresh()
    await Bun.sleep(30)
    expect(host.querySelectorAll(".resource-monitor__devices article")).toHaveLength(1)
    expect(host.textContent).toContain("Showing the last successful sample")
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Compute node"]')!.value).toBe("n2")
  }
  target.value = ""
  target.dispatchEvent(new Event("change", { bubbles: true }))
  await ready(() => host.querySelector(".resource-monitor__context")?.textContent?.includes("Login node") ?? false)
  expect(target.value).toBe("")
  expect([...target.options].some((option) => option.value === "slurm:41")).toBe(false)
  expect(requests.at(-1)?.target).toBeUndefined()
  expect(host.querySelectorAll(".resource-monitor__devices article")).toHaveLength(0)
})
test("pause stops sampling and resume immediately refreshes", async () => {
  let calls = 0
  const { host } = mount(async () => {
    calls++
    return Response.json(report())
  })
  await ready(() => host.textContent?.includes("85.0%") ?? false)
  host.querySelector<HTMLButtonElement>('[aria-label="Pause resource monitoring"]')!.click()
  const paused = calls
  refresh()
  await Bun.sleep(30)
  expect(calls).toBe(paused)
  host.querySelector<HTMLButtonElement>('[aria-label="Resume resource monitoring"]')!.click()
  await ready(() => calls > paused)
})
test("repeated unavailable samples retain the last metrics and mark them as stale", async () => {
  let available = true
  const { host } = mount(async () =>
    Response.json(
      available ? report() : { ...report(), state: "unavailable", sample: null, nodes: [], node: undefined },
    ),
  )
  await ready(() => host.textContent?.includes("85.0%") ?? false)
  available = false
  for (let index = 0; index < 3; index++) {
    refresh()
    await Bun.sleep(30)
  }
  expect(host.textContent).toContain("85.0%")
  expect(host.textContent).toContain("Showing the last successful sample")
  expect(host.querySelector(".resource-monitor")?.getAttribute("data-state")).toBe("unavailable")
})
test("changing sessions aborts a request and ignores its late response", async () => {
  const pending = Promise.withResolvers<Response>()
  const signals: AbortSignal[] = []
  const { host, changeSession } = mount(async (_, init, query) => {
    signals.push(init!.signal!)
    if (query?.sessionID === "ses_first") return pending.promise
    return Response.json({ ...report(), selected: "host", sample: null, state: "queued" })
  })
  await ready(() => signals.length > 0)
  changeSession("ses_second")
  await ready(() => host.textContent?.includes("Waiting for the scheduler") ?? false)
  expect(signals[0].aborted).toBe(true)
  pending.resolve(Response.json(report()))
  await Bun.sleep(30)
  expect(host.textContent).not.toContain("85.0%")
})
test("unmount aborts pending work and an older backend has an actionable state", async () => {
  const { host, dispose } = mount(async () => new Response("Not found", { status: 404 }))
  await ready(() => host.textContent?.includes("updated backend") ?? false)
  expect(host.querySelector(".resource-monitor")?.getAttribute("data-state")).toBe("unavailable")
  dispose()
  expect(host.textContent).toBe("")
})

test("explicitly suspending the sampler stops requests and resuming refreshes immediately", async () => {
  let calls = 0
  const { host, changeVisibility } = mount(async () => {
    calls++
    return Response.json(report())
  })
  await ready(() => host.textContent?.includes("85.0%") ?? false)
  changeVisibility(false)
  const before = calls
  refresh()
  await Bun.sleep(30)
  expect(calls).toBe(before)
  changeVisibility(true)
  await ready(() => calls > before)
})

test("an open compute tab keeps its sampler and history while hidden, then cancels on close", async () => {
  let calls = 0
  const signals: AbortSignal[] = []
  const host = document.createElement("div")
  document.body.append(host)
  let change: (state: { open?: boolean; visible?: boolean }) => void = () => {}
  cleanups.push(
    web.render(
      () =>
        web.createComponent(subject.MonitorTabFixture, {
          request: async (_, init) => {
            signals.push(init!.signal!)
            return Response.json({ ...report(100_000 + ++calls * 5000), intervalMs: 1000 })
          },
          control: (control) => {
            change = control
          },
        }),
      host,
    ),
  )
  expect(calls).toBe(0)
  change({ open: true, visible: true })
  await ready(() => calls === 1 && !!host.querySelector("svg"))
  const monitor = host.querySelector(".resource-monitor")
  const first = host.querySelector(".resource-chart__line")!.getAttribute("d")!
  change({ visible: false })
  expect(host.querySelector("[data-component=compute-context]")?.hasAttribute("hidden")).toBe(true)
  await Bun.sleep(1100)
  expect(calls).toBeGreaterThanOrEqual(2)
  change({ visible: true })
  expect(host.querySelector(".resource-monitor")).toBe(monitor)
  const path = host.querySelector(".resource-chart__line")!.getAttribute("d")!
  expect(path).not.toBe(first)
  expect(path.match(/M/g)).toHaveLength(1)
  expect(path.match(/L/g)!.length).toBeGreaterThanOrEqual(1)
  change({ open: false })
  expect(host.querySelector(".resource-monitor")).toBeNull()
  expect(signals.at(-1)!.aborted).toBe(true)
  const before = calls
  refresh()
  await Bun.sleep(1100)
  expect(calls).toBe(before)
})

test("a hidden browser document still samples while the compute tab remains open", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(document, "hidden")
  Object.defineProperty(document, "hidden", { configurable: true, value: true })
  cleanups.push(() => {
    if (descriptor) Object.defineProperty(document, "hidden", descriptor)
    else Reflect.deleteProperty(document, "hidden")
  })
  let calls = 0
  const { host } = mount(async () => Response.json({ ...report(100_000 + ++calls * 5000), intervalMs: 1000 }))
  await ready(() => host.textContent?.includes("85.0%") ?? false)
  await Bun.sleep(1100)
  expect(calls).toBeGreaterThanOrEqual(2)
})

test("switching sessions restores isolated target choices and history", async () => {
  let time = 100_000
  const { host, changeSession } = mount(async (_, __, query) => {
    const result = report((time += 5000))
    result.selected = typeof query?.target === "string" ? query.target : "slurm:41"
    result.sample!.cpu.utilization = query?.sessionID === "ses_first" ? 25 : 80
    return Response.json(result)
  })
  await ready(() => host.querySelector(".resource-monitor__metric strong")?.textContent === "25.0%")
  const target = host.querySelector<HTMLSelectElement>('[aria-label="Compute target"]')!
  target.value = "host"
  target.dispatchEvent(new Event("change", { bubbles: true }))
  await Bun.sleep(30)
  refresh()
  await Bun.sleep(30)
  const first = host.querySelector(".resource-chart__line")!.getAttribute("d")!
  expect(first.match(/L/g)).toHaveLength(1)
  changeSession("ses_second")
  await ready(() => host.querySelector(".resource-monitor__metric strong")?.textContent === "80.0%")
  expect(target.value).toBe("")
  expect(host.querySelector(".resource-chart__line")!.getAttribute("d")!.match(/L/g)).toBeNull()
  changeSession("ses_first")
  await ready(() => host.querySelector(".resource-monitor__metric strong")?.textContent === "25.0%")
  expect(target.value).toBe("host")
  await ready(() => host.querySelector(".resource-chart__line")!.getAttribute("d")!.match(/M/g)?.length === 2)
  const restored = host.querySelector(".resource-chart__line")!.getAttribute("d")!
  expect(restored.match(/L/g)).toHaveLength(1)
  expect(restored.match(/M/g)).toHaveLength(2)
})

test("only a real failed sample breaks a series, while a successful slow sample stays connected", async () => {
  let calls = 0
  const { host } = mount(async () => {
    calls++
    if (calls === 3) return new Response("Disconnected", { status: 503 })
    return Response.json(report(100_000 + calls * 25_000))
  })
  await ready(() => host.textContent?.includes("85.0%") ?? false)
  refresh()
  await Bun.sleep(30)
  expect(host.querySelector(".resource-chart__line")!.getAttribute("d")!.match(/M/g)).toHaveLength(1)
  refresh()
  await ready(() => host.querySelector(".resource-monitor")?.getAttribute("data-state") === "stale")
  refresh()
  await ready(() => host.querySelector(".resource-monitor")?.getAttribute("data-state") === "live")
  expect(host.querySelector(".resource-chart__line")!.getAttribute("d")!.match(/M/g)).toHaveLength(2)
  expect(
    host.querySelector(".resource-monitor__devices .resource-chart__line")!.getAttribute("d")!.match(/M/g),
  ).toHaveLength(2)
})

test("an unavailable new node never reuses a different node's history", async () => {
  const { host } = mount(async (_, __, query) =>
    Response.json(
      query?.node === "n2" ? { ...report(), state: "unavailable", sample: null, node: undefined } : report(),
    ),
  )
  await ready(() => host.textContent?.includes("85.0%") ?? false)
  const node = host.querySelector<HTMLSelectElement>('[aria-label="Compute node"]')!
  node.value = "n2"
  node.dispatchEvent(new Event("change", { bubbles: true }))
  await ready(() => host.textContent?.includes("Node telemetry is currently unavailable") ?? false)
  expect(host.textContent).not.toContain("85.0%")
})

test("an explicit compute target survives its first response and subsequent inventory refreshes", async () => {
  let responses = 0
  const targets: unknown[] = []
  const { host } = mount(async (_, __, query) => {
    targets.push(query?.target)
    const result = report(100_000 + ++responses * 5000)
    return Response.json({ ...result, selected: query?.target ?? result.selected })
  })
  await ready(() => host.textContent?.includes("85.0%") ?? false)
  const target = host.querySelector<HTMLSelectElement>('[aria-label="Compute target"]')!
  const option = target.options[1]
  target.value = "host"
  target.dispatchEvent(new Event("change", { bubbles: true }))
  await ready(() => responses === 2 && host.querySelector(".resource-monitor")?.getAttribute("data-state") === "live")
  expect(target.value).toBe("host")
  expect(target.selectedOptions[0].textContent).toBe("Login node")

  for (let index = 0; index < 3; index++) {
    refresh()
    await ready(() => responses === index + 3)
    await Bun.sleep(10)
    expect(target.value).toBe("host")
    expect(target.options[1]).toBe(option)
  }
  expect(targets.slice(1)).toEqual(["host", "host", "host", "host"])

  target.value = ""
  target.dispatchEvent(new Event("change", { bubbles: true }))
  await ready(() => responses === 6)
  await Bun.sleep(10)
  expect(target.value).toBe("")
  expect(targets.at(-1)).toBeUndefined()
})

test("target and node selections follow their identifiers when discovery changes ordering", async () => {
  let reordered = false
  let responses = 0
  const nodes: unknown[] = []
  const { host } = mount(async (_, __, query) => {
    const result = report(100_000 + ++responses * 5000)
    nodes.push(query?.node)
    return Response.json({
      ...result,
      selected: query?.target ?? result.selected,
      node: query?.node ?? "n1",
      targets: reordered ? result.targets.toReversed() : result.targets,
      nodes: reordered ? result.nodes.toReversed() : result.nodes,
    })
  })
  await ready(() => host.textContent?.includes("85.0%") ?? false)
  const node = host.querySelector<HTMLSelectElement>('[aria-label="Compute node"]')!
  node.value = "n2"
  node.dispatchEvent(new Event("change", { bubbles: true }))
  await ready(() => responses === 2 && !!host.querySelector('[aria-label="Compute node"]'))
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Compute target"]')!.value).toBe("slurm:41")
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Compute node"]')!.value).toBe("n2")
  reordered = true
  refresh()
  await ready(() => responses === 3)
  await Bun.sleep(10)
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Compute target"]')!.value).toBe("slurm:41")
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Compute node"]')!.value).toBe("n2")
  expect(nodes.slice(1)).toEqual(["n2", "n2"])
})
