import { expect, test } from "bun:test"
import path from "node:path"
import { realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { ComputeEnvironment } from "../../src/compute/environment"
import { acceleratorProbes, devices } from "../../src/compute/telemetry-devices"

test("Windows monitor environment retains driver locations without credentials or execution hooks", () => {
  const source = {
    Path: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    ProgramW6432: "C:\\Program Files",
    ProgramData: "C:\\ProgramData",
    OPENAI_API_KEY: "secret",
    MODAL_TOKEN_SECRET: "secret",
    NODE_OPTIONS: "untrusted",
    LD_PRELOAD: "untrusted",
  }
  const env = ComputeEnvironment.runtimeEnvironment(source, "win32")
  expect(env).toMatchObject({
    PATH: source.Path,
    SYSTEMROOT: source.SystemRoot,
    PROGRAMFILES: source.ProgramFiles,
    "PROGRAMFILES(X86)": source["ProgramFiles(x86)"],
    PROGRAMW6432: source.ProgramW6432,
    PROGRAMDATA: source.ProgramData,
  })
  for (const key of ["OPENAI_API_KEY", "MODAL_TOKEN_SECRET", "NODE_OPTIONS", "LD_PRELOAD"])
    expect(env[key]).toBeUndefined()
  const linux = ComputeEnvironment.runtimeEnvironment(source, "linux")
  expect(linux.PROGRAMFILES).toBeUndefined()
  expect(linux.ProgramFiles).toBeUndefined()
})

test.skipIf(process.platform !== "win32")(
  "Windows probes keep System32 and explain native query failures",
  async () => {
    const env = await ComputeEnvironment.probeEnvironment()
    const system = path.join(process.env.SYSTEMROOT!, "System32").toLowerCase()
    expect(env.PATH.split(path.delimiter).map((entry) => path.resolve(entry).toLowerCase())).toContain(system)
    const result = await ComputeEnvironment.probe(
      {
        id: "diagnostic",
        command: "cmd.exe",
        args: ["/d", "/c", "echo Driver diagnostic & exit /b 7"],
        columns: "test",
      },
      env,
    )
    expect(result.status).toBe("error")
    expect(result.detail).toBe("Driver diagnostic")
    const empty = await ComputeEnvironment.probe(
      { id: "diagnostic", command: "cmd.exe", args: ["/d", "/c", "exit /b 7"], columns: "test" },
      env,
    )
    expect(empty.detail).toBe("Query exited with code 7.")
  },
)

const native = process.platform === "win32" ? Bun.which("nvidia-smi") : null
const nvidia =
  native &&
  realpathSync(native)
    .toLowerCase()
    .startsWith(path.resolve(process.env.SYSTEMROOT!, "System32").toLowerCase() + path.sep)
    ? native
    : null
const baseline = nvidia
  ? spawnSync(nvidia, [...acceleratorProbes[0].args], { encoding: "utf8", windowsHide: true, timeout: 8000 })
  : null
test.skipIf(baseline?.status !== 0)(
  "Windows monitoring reads the same installed GPUs as native nvidia-smi",
  async () => {
    const result = await ComputeEnvironment.probe(
      { ...acceleratorProbes[0], columns: "Device telemetry" },
      await ComputeEnvironment.probeEnvironment(),
    )
    expect(result.status).toBe("ready")
    const inventory = (output: string) =>
      devices([{ ...result, output }]).devices.map(({ id, name, memoryTotal }) => ({ id, name, memoryTotal }))
    expect(inventory(result.output).length).toBeGreaterThan(0)
    expect(inventory(result.output)).toEqual(inventory(baseline!.stdout))
  },
)

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
