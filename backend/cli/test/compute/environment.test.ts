import { expect, test } from "bun:test"
import { ComputeEnvironment } from "../../src/compute/environment"

test("environment probes distinguish missing runtime dependencies, restrictions and unavailable GPUs", () => {
  expect(ComputeEnvironment.classify(127, "libslurmfull.so: cannot open shared object file")).toBe("dependency_error")
  expect(ComputeEnvironment.classify(1, "Fatal Python error: Failed to import encodings module")).toBe(
    "dependency_error",
  )
  expect(ComputeEnvironment.classify(1, "Munge authentication error")).toBe("restricted")
  expect(ComputeEnvironment.classify(1, "Permission denied")).toBe("restricted")
  expect(ComputeEnvironment.classify(1, "No devices were found")).toBe("unavailable")
  expect(ComputeEnvironment.classify(1, "Unable to contact slurm controller")).toBe("error")
  expect(ComputeEnvironment.classify(0, "")).toBe("ready")
})

test("container quotas do not claim all host resources as available", () => {
  expect(ComputeEnvironment.limits({ cpu: 8, total: 64000, free: 40000, quota: "50000 100000" }).cpu).toBe(0.5)
  expect(
    ComputeEnvironment.limits({
      cpu: 32,
      total: 64000,
      free: 40000,
      quota: "200000 100000",
      memory: "8000",
      used: "3000",
    }),
  ).toEqual({ cpu: 2, memory: { total: 64000, available: 5000, limit: 8000 } })
  expect(ComputeEnvironment.limits({ cpu: 8, total: 64000, free: 40000, quota: "max 100000", memory: "max" })).toEqual({
    cpu: 8,
    memory: { total: 64000, available: 40000 },
  })
  expect(
    ComputeEnvironment.limits({ cpu: 8, total: 64000, free: 40000, quota: "-1 100000", memory: "9223372036854771712" })
      .memory.available,
  ).toBe(40000)
})

test("ordinary hosts return a complete inventory without requiring a scheduler", async () => {
  const result = await ComputeEnvironment.inspect()
  expect(ComputeEnvironment.Info.safeParse(result).success).toBe(true)
  expect(result.hostname.length).toBeGreaterThan(0)
  expect(result.cpu.available).toBeGreaterThan(0)
  expect(result.schedulers.map((item) => item.id)).toEqual(["slurm", "slurm_queue", "pbs", "lsf", "sge"])
  expect(result.notes.join(" ")).toContain("not an entire cluster")
  expect(await ComputeEnvironment.inspect()).toBe(result)
}, 15000)
