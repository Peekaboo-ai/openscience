import { expect, test } from "bun:test"
import {
  appendSample,
  memoryLabel,
  memoryPercent,
  metricPath,
  parseMonitor,
  percentLabel,
  type MonitorReport,
  type MonitorSample,
} from "./compute-monitor"

const sample = (sampledAt: number): MonitorSample => ({
  sampledAt,
  hostname: "node1",
  cpu: { cores: 8, utilization: 25 },
  memory: { used: 4, total: 8 },
  devices: [],
  issues: [],
})
test("retains a bounded chronological history without duplicate cached samples", () => {
  const previous = [sample(1000)]
  expect(appendSample(previous, sample(1000))).toBe(previous)
  expect(appendSample(previous, sample(500))).toBe(previous)
  expect(appendSample(previous, sample(1_000_000))).toEqual([sample(1_000_000)])
  expect(
    appendSample(
      Array.from({ length: 200 }, (_, index) => sample(index * 1000)),
      sample(201_000),
    ),
  ).toHaveLength(181)
})
test("chart gaps represent missing samples and interruptions instead of fabricated zeroes", () => {
  const path = metricPath(
    [
      { time: 0, value: 0 },
      { time: 5000, value: 50 },
      { time: 10000, value: null },
      { time: 15000, value: 80 },
      { time: 60000, value: 10, gapBefore: true },
    ],
    0,
    60000,
  )
  expect(path.match(/M/g)).toHaveLength(3)
  expect(path.match(/L/g)).toHaveLength(1)
  expect(path).not.toContain("NaN")
})

test("continuous successful slow samples remain connected without manufacturing missing samples", () => {
  const path = metricPath(
    [
      { time: 0, value: 25 },
      { time: 25_000, value: 50 },
    ],
    0,
    60_000,
  )
  expect(path.match(/M/g)).toHaveLength(1)
  expect(path.match(/L/g)).toHaveLength(1)
})
test("unavailable resources stay distinct from zero usage", () => {
  expect(percentLabel(null)).toBe("—")
  expect(percentLabel(0)).toBe("0.0%")
  expect(memoryPercent({ used: 0, total: 8 })).toBe(0)
  expect(memoryPercent({ used: null, total: 8 })).toBeNull()
  expect(memoryLabel(null, null)).toBe("— / — GiB")
})
test("invalid server responses cannot render as a live monitor", () => {
  expect(() => parseMonitor({})).toThrow("invalid response")
  expect(() => parseMonitor({ targets: [], nodes: [], issues: [], state: "live", sample: {} })).toThrow()
})

const allocation = (): MonitorReport => ({
  selected: "job:broker-7",
  targets: [{ id: "job:broker-7", label: "Training", kind: "slurm", state: "running", jobID: "41" }],
  nodes: ["node1"],
  node: "node1",
  state: "live",
  intervalMs: 5000,
  issues: [],
  sample: {
    ...sample(1000),
    acceleratorScope: { kind: "allocation", jobID: "41", expectedDevices: 4 },
    devices: Array.from({ length: 4 }, (_, index) => ({
      id: `sysfs:${index}`,
      name: `DCU ${index}`,
      kind: "DCU",
      source: "sysfs",
      utilization: 20,
      memoryUsed: 1,
      memoryTotal: 4,
      memoryPercent: 25,
      temperature: 50,
      power: 80,
    })),
  },
})

test("broker targets use the scheduler job identity when validating accelerator ownership", () => {
  const result = allocation()
  expect(parseMonitor(result).sample!.devices).toHaveLength(4)
  result.sample!.acceleratorScope!.jobID = "another-job"
  const mismatch = parseMonitor(result).sample!
  expect(mismatch.devices).toHaveLength(0)
  expect(mismatch.acceleratorScope?.kind).toBe("unavailable")
  expect(mismatch.cpu).toEqual(result.sample!.cpu)
  expect(mismatch.memory).toEqual(result.sample!.memory)
  const unidentified = allocation()
  delete unidentified.targets[0].jobID
  expect(parseMonitor(unidentified).sample!.devices).toHaveLength(0)
})

test("allocation device counts must match exactly and unknown counts cannot label node devices as allocated", () => {
  for (const expectedDevices of [undefined, -1, 2.5, 0, 3, 5]) {
    const result = allocation()
    result.sample!.acceleratorScope!.expectedDevices = expectedDevices
    const reading = parseMonitor(result).sample!
    expect(reading.devices).toHaveLength(0)
    expect(reading.acceleratorScope?.kind).toBe("unavailable")
    expect(reading.cpu.utilization).toBe(25)
  }
})

test("duplicate or empty device identities and missing job identity cannot produce an allocation", () => {
  for (const identity of ["", "sysfs:0"]) {
    const result = allocation()
    result.sample!.devices[1].id = identity
    expect(parseMonitor(result).sample!.devices).toHaveLength(0)
  }
  for (const jobID of [undefined, "", " "]) {
    const result = allocation()
    result.sample!.acceleratorScope!.jobID = jobID
    expect(parseMonitor(result).sample!.devices).toHaveLength(0)
  }
})

test("broker scheduler targets never accept a host scope or missing allocation scope", () => {
  for (const scope of [undefined, { kind: "host" as const }]) {
    const result = allocation()
    result.sample!.acceleratorScope = scope
    const reading = parseMonitor(result).sample!
    expect(reading.devices).toHaveLength(0)
    expect(reading.acceleratorScope?.kind).toBe("unavailable")
  }
})
