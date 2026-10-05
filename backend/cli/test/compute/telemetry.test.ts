import { describe, expect, test } from "bun:test"
import { devices } from "../../src/compute/telemetry-devices"
import {
  ComputeTelemetry,
  cached,
  cpuPercent,
  decode,
  pbsTargets,
  sampleHost,
  slurmTargets,
} from "../../src/compute/telemetry"

const probe = (id: string, command: string, output: string, status = "ready") => ({ id, command, output, status })

describe("accelerator telemetry", () => {
  test("reads individual NVIDIA cards, byte units and unsupported metrics", () => {
    const result = devices([
      probe(
        "nvidia",
        "nvidia-smi",
        '0, NVIDIA A100, 75, 10240, 40960, 62, 221.5\n1, "NVIDIA GPU, PCIe", N/A, N/A, 40960, N/A, [Not Supported]',
      ),
    ])
    expect(result.devices).toHaveLength(2)
    expect(result.devices[0]).toMatchObject({
      memoryUsed: 10 * 1024 ** 3,
      memoryPercent: 25,
      utilization: 75,
      power: 221.5,
    })
    expect(result.devices[1]).toMatchObject({
      name: "NVIDIA GPU, PCIe",
      utilization: null,
      memoryUsed: null,
      temperature: null,
      power: null,
    })
  })
  test("reads all Hygon DCUs from JSON and does not duplicate ROCm compatibility devices", () => {
    const output = JSON.stringify({
      card0: {
        "DCU use (%)": "92",
        "VRAM Total Memory (B)": "34359738368",
        "VRAM Total Used Memory (B)": "8589934592",
        "Temperature (Sensor edge) (C)": "54.0",
        "Average Graphics Package Power (W)": "132",
      },
      card1: { "DCU use (%)": "0" },
    })
    const result = devices([probe("hygon", "hy-smi", output), probe("amd", "rocm-smi", output)])
    expect(result.devices).toHaveLength(2)
    expect(result.devices[0]).toMatchObject({ kind: "DCU", utilization: 92, memoryPercent: 25, temperature: 54 })
    expect(result.devices[1].utilization).toBe(0)
    expect(result.devices[1].memoryUsed).toBeNull()
  })
  test("supports legacy hy-smi table output without inventing memory capacity", () => {
    const output =
      "DCU Temp AvgPwr SCLK MCLK Fan Perf PwrCap VRAM% DCU%\n0 46.0c 32.0W 700Mhz 1200Mhz 0% auto 300W 20% 84%\n1 45.0c 30.0W 700Mhz 1200Mhz 0% auto 300W 0% 0%"
    const result = devices([probe("hygon", "hy-smi", output)])
    expect(result.devices).toHaveLength(2)
    expect(result.devices[0]).toMatchObject({ memoryPercent: 20, utilization: 84, memoryTotal: null })
  })
  test("reads current hyhal HCU metrics, MiB units and its missing power delimiters", () => {
    const result = devices([
      probe(
        "hygon",
        "hy-smi",
        '{"card0":{"Average Graphics Package Power (W)":"80.0""Average GFX Core Power (W)":"9.0""Average Memory Power (W)":"35.0","HCU use (%)":"0.0","vram Total Used Memory (MiB)":"1166","vram Total Memory (MiB)":"65520"}}',
      ),
    ])
    expect(result.issues).toEqual([])
    expect(result.devices[0]).toMatchObject({
      kind: "DCU" as const,
      utilization: 0,
      power: 80,
      memoryUsed: 1166 * 1024 ** 2,
      memoryTotal: 65520 * 1024 ** 2,
    })
  })
  test("prefers physical kernel devices over a remapped Hygon client inventory", () => {
    const kernel: ComputeTelemetry.Device = {
      id: "drm:0000:81:00.0",
      name: "Hygon DCU · 0000:81:00.0",
      source: "sysfs",
      kind: "DCU",
      utilization: 0,
      memoryUsed: 1024,
      memoryTotal: 4096,
      memoryPercent: 25,
      temperature: 53,
      power: 80,
    }
    const result = devices([
      probe("drm", "sysfs", JSON.stringify([kernel])),
      probe("hygon", "hy-smi", '{"card0":{"HCU use (%)":"0"}}'),
    ])
    expect(result.devices).toEqual([kernel])
    const fallback = devices([
      probe("drm", "sysfs", JSON.stringify([{ ...kernel, memoryUsed: null }])),
      probe("hygon", "hy-smi", '{"card0":{"HCU use (%)":"12"}}'),
    ])
    expect(fallback.devices).toHaveLength(1)
    expect(fallback.devices[0]).toMatchObject({ source: "hy-smi", utilization: 12 })
  })
  test("parses ROCm byte counts and GPU utilization", () => {
    const result = devices([
      probe(
        "amd",
        "rocm-smi",
        JSON.stringify({
          card0: {
            "Card series": "AMD Instinct MI300X",
            "GPU use (%)": "99",
            "VRAM Total Memory (B)": 192 * 1024 ** 3,
            "VRAM Total Used Memory (B)": 96 * 1024 ** 3,
          },
        }),
      ),
    ])
    expect(result.devices[0]).toMatchObject({
      name: "AMD Instinct MI300X",
      kind: "GPU",
      memoryPercent: 50,
      utilization: 99,
    })
  })
  test("supports the official TPU runtime table and distinguishes duty cycle from memory", () => {
    const result = devices([
      probe(
        "tpu",
        "tpu-info",
        "Accelerator type: v6e\nTPU Runtime Utilization\n│ 0 │ 18.45 GiB / 31.25 GiB │ 100.00% │\n│ 1 │ 10.40 GiB / 31.25 GiB │ 0.00% │\nTensorCore Utilization\n│ 0 │ 13.60% │",
      ),
    ])
    expect(result.devices).toHaveLength(2)
    expect(result.devices[0]).toMatchObject({ kind: "TPU", utilization: 100, memoryTotal: 31.25 * 1024 ** 3 })
    expect(result.devices[1].utilization).toBe(0)
  })
  test("retains successful devices when another probe fails", () => {
    const result = devices([
      probe("nvidia", "nvidia-smi", "0, GPU, 101, 0, 1024, N/A, N/A"),
      probe("hygon", "hy-smi", "", "timeout"),
      probe("amd", "rocm-smi", "", "not_installed"),
    ])
    expect(result.devices[0].utilization).toBeNull()
    expect(result.issues).toEqual(["hy-smi: timeout"])
  })
  test("malformed JSON and missing devices are observable, never zero usage", () => {
    expect(devices([probe("amd", "rocm-smi", "{broken}")]).issues.length).toBe(1)
    expect(devices([probe("nvidia", "nvidia-smi", "No devices")]).devices).toEqual([])
  })
})

describe("monitor targets and lifecycle", () => {
  test("matches project roots on path boundaries and associates only known session paths", () => {
    const rows =
      "10|training|RUNNING|node[1-2]|/work/Bio/ses_abc/run\n11|other|RUNNING|node3|/work/Biology\n12|pending|PENDING|(null)|/work/Bio\n13;bad|x|RUNNING|node|/work/Bio"
    const result = slurmTargets(rows, ["/work/Bio"], "ses_abc")
    expect(result.map((target) => target.id)).toEqual(["slurm:10", "slurm:12"])
    expect(result[0].sessionID).toBe("ses_abc")
    expect(result[1].state).toBe("queued")
    expect(result[1].sessionID).toBeUndefined()
  })
  test("PBS discovery excludes other users, unrelated directories and completed jobs", () => {
    const job = {
      Job_Name: "fit",
      Job_Owner: "scientist@login",
      job_state: "R",
      Variable_List: { PBS_O_WORKDIR: "/work/Bio" },
    }
    const result = pbsTargets(
      JSON.stringify({
        Jobs: {
          "22.server": job,
          "23.server": { ...job, Job_Owner: "other@login" },
          "24.server": { ...job, job_state: "F" },
        },
      }),
      ["/work/Bio"],
      "scientist",
    )
    expect(result.map((target) => target.id)).toEqual(["pbs:22.server"])
  })
  test("normalizes CPU counter deltas and missing samples", () => {
    expect(cpuPercent({ total: 100, idle: 60 }, { total: 200, idle: 80 })).toBe(80)
    expect(cpuPercent({ total: 100, idle: 60 }, { total: 100, idle: 60 })).toBeNull()
  })
  test("coalesces concurrent requests and retries rejected reads", async () => {
    const cache = cached<number>(2)
    let calls = 0
    const load = async () => ++calls
    expect(await Promise.all([cache("a", 1000, load), cache("a", 1000, load)])).toEqual([1, 1])
    await expect(cache("b", 1000, () => Promise.reject(new Error("offline")))).rejects.toThrow("offline")
    expect(await cache("b", 1000, load)).toBe(2)
  })
  test("rejects malformed node reports and preserves pending state", () => {
    expect(decode('{"state":"queued","nodes":[],"sample":null}')).toMatchObject({ state: "queued", sample: null })
    expect(() => decode('{"state":"live","nodes":[],"sample":{"cpu":{}}}')).toThrow()
  })
  test("requires verified allocation identity and exact device count for scheduler samples", () => {
    const card: ComputeTelemetry.Device = {
      id: "drm:0000:09:00.0",
      name: "DCU",
      kind: "DCU",
      source: "sysfs",
      utilization: 10,
      memoryUsed: 1024,
      memoryTotal: 4096,
      memoryPercent: 25,
      temperature: 40,
      power: 50,
    }
    const read = (scope?: ComputeTelemetry.Sample["acceleratorScope"], cards = [card]) =>
      decode(
        JSON.stringify({
          state: "live",
          nodes: ["node1"],
          node: "node1",
          sample: {
            sampledAt: 123,
            hostname: "node1",
            cpu: { utilization: 42, cores: 8 },
            memory: { used: 1024, total: 4096 },
            acceleratorScope: scope,
            probes: [probe("drm", "sysfs", JSON.stringify(cards))],
          },
        }),
        { scheduler: "slurm", jobID: "41" },
      )
    const valid = { kind: "allocation" as const, jobID: "41", expectedDevices: 1 }
    expect(read(valid).sample?.devices).toEqual([card])
    expect(read({ ...valid, expectedDevices: 0 }, []).sample?.acceleratorScope?.kind).toBe("allocation")
    for (const scope of [
      undefined,
      { kind: "host" as const },
      { ...valid, jobID: "410" },
      { ...valid, expectedDevices: 8 },
      { ...valid, expectedDevices: undefined },
    ]) {
      const result = read(scope)
      expect(result.sample?.devices).toEqual([])
      expect(result.sample?.acceleratorScope?.kind).toBe("unavailable")
      expect(result.sample?.cpu.utilization).toBe(42)
      expect(result.sample?.memory.used).toBe(1024)
    }
    expect(read({ ...valid, expectedDevices: 2 }, [card, card]).sample?.devices).toEqual([])
    expect(
      read({ kind: "unavailable", jobID: "41", reason: "Device isolation is disabled" }).sample?.acceleratorScope
        ?.reason,
    ).toBe("Device isolation is disabled")
  })
  test("coalesces slow samples without extending their freshness after completion", async () => {
    const cache = cached<number>(2)
    const pending = Promise.withResolvers<number>()
    const first = cache("node", 10, () => pending.promise)
    await Bun.sleep(25)
    expect(cache("node", 10, () => Promise.resolve(2))).toBe(first)
    pending.resolve(1)
    expect(await first).toBe(1)
    expect(await cache("node", 10, () => Promise.resolve(2))).toBe(2)
  })
  test("samples an ordinary host without requiring Python, a GPU or a scheduler", async () => {
    const result = await sampleHost()
    expect(ComputeTelemetry.Sample.safeParse(result.sample).success).toBe(true)
    expect(result.sample!.cpu.cores).toBeGreaterThan(0)
    expect(result.sample!.memory.total).toBeGreaterThan(0)
  }, 15000)
})
