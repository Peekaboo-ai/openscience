import os from "node:os"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import z from "zod"
import { OpenScience } from "../openscience"
import { validateQuery } from "./query-arguments"

const MAX_OUTPUT = 64 * 1024
const TIMEOUT = 8_000
const probes = [
  {
    id: "slurm",
    command: "sinfo",
    args: ["--noheader", "--format=%P|%a|%l|%D|%t|%C|%m|%G"],
    columns: "partition|availability|time_limit|nodes|state|cpus_alloc/idle/other/total|memory_MiB_per_node|gres",
  },
  {
    id: "slurm_queue",
    command: "squeue",
    args: ["--noheader", "--me", "--format=%i|%P|%j|%T|%M|%D|%R"],
    columns: "job_id|partition|name|state|elapsed|nodes|reason_or_nodes",
  },
  { id: "pbs", command: "pbsnodes", args: ["-a"], columns: "PBS node attributes" },
  { id: "lsf", command: "bhosts", args: ["-w"], columns: "LSF host status" },
  { id: "sge", command: "qhost", args: [], columns: "SGE host status" },
  {
    id: "nvidia",
    command: "nvidia-smi",
    args: ["--query-gpu=index,name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
    columns: "index,name,memory_total_MiB,memory_used_MiB,utilization_percent",
  },
  {
    id: "amd",
    command: "rocm-smi",
    args: ["--showproductname", "--showmeminfo", "vram", "--json"],
    columns: "AMD GPU resources",
  },
] as const

export namespace ComputeEnvironment {
  export const Check = z.object({
    id: z.string(),
    command: z.string(),
    status: z.enum(["ready", "not_installed", "restricted", "timeout", "dependency_error", "unavailable", "error"]),
    executable: z.string().optional(),
    columns: z.string(),
    output: z.string(),
    detail: z.string().optional(),
    truncated: z.boolean(),
  })
  export const Info = z.object({
    authority: z.enum(["local", "remote"]),
    hostname: z.string(),
    platform: z.string(),
    arch: z.string(),
    kind: z.enum(["host", "wsl", "container"]),
    sampledAt: z.number(),
    cpu: z.object({ logical: z.number(), available: z.number() }),
    memory: z.object({ total: z.number(), available: z.number(), limit: z.number().optional() }),
    schedulers: z.array(Check),
    accelerators: z.array(Check),
    runtimes: z.array(z.object({ name: z.string(), executable: z.string() })),
    notes: z.array(z.string()),
  })
  export type Info = z.infer<typeof Info>
  export type Check = z.infer<typeof Check>

  export function classify(code: number | null, output: string): Check["status"] {
    if (
      /error while loading shared libraries|cannot open shared object|library not loaded|no module named|failed to import.*encodings/i.test(
        output,
      )
    )
      return "dependency_error"
    if (/permission denied|access denied|not authorized|authentication|munge.*(?:fail|error)/i.test(output))
      return "restricted"
    if (/no devices were found|no supported gpu|driver.*not loaded|couldn.t communicate with.*driver/i.test(output))
      return "unavailable"
    return code === 0 ? "ready" : "error"
  }

  // 固定只读参数、绝对系统程序与受限环境构成宿主查询边界；不接受用户命令。
  async function administratorOwned(file: string) {
    if (process.platform === "win32") {
      const system = path.resolve(process.env.SYSTEMROOT ?? "C:\\Windows", "System32").toLowerCase()
      return file.toLowerCase().startsWith(system + path.sep)
    }
    let current = file
    for (;;) {
      const stat = await fs.stat(current)
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) return false
      const parent = path.dirname(current)
      if (parent === current) return true
      current = parent
    }
  }

  async function probeEnvironment() {
    const env = OpenScience.kernelEnv(process.env)
    for (const key of ["PYTHONHOME", "PYTHONPATH", "CONDA_PREFIX", "VIRTUAL_ENV"]) delete env[key]
    // 宿主只读探测不能通过项目可写 PATH、动态库或解释器覆盖项加载任意代码。
    for (const key of ["PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"]) {
      const entries = [...new Set((env[key] ?? "").split(path.delimiter))].filter(path.isAbsolute)
      const safe = await Promise.all(
        entries.map(async (entry) => {
          const real = await fs.realpath(entry).catch(() => undefined)
          return real && (await administratorOwned(real).catch(() => false)) ? entry : undefined
        }),
      )
      env[key] = safe.filter((entry): entry is string => !!entry).join(path.delimiter)
      if (!env[key]) delete env[key]
    }
    env.PATH ??=
      process.platform === "win32" ? path.join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32") : "/usr/bin:/bin"
    for (const key of ["SLURM_CONF", "PBS_CONF_FILE", "LSF_ENVDIR", "SGE_ROOT"]) {
      const value = process.env[key]
      if (value && path.isAbsolute(value) && (await administratorOwned(value).catch(() => false))) env[key] = value
    }
    if (/^[\w.-]+$/.test(process.env.SGE_CELL ?? "")) env.SGE_CELL = process.env.SGE_CELL!
    env.LC_ALL = "C"
    return env
  }

  async function probe(
    spec: { id: string; command: string; args: readonly string[]; columns: string },
    env: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Check> {
    const found = Bun.which(spec.command, { PATH: process.env.PATH, cwd: path.parse(process.cwd()).root })
    const base = { id: spec.id, command: spec.command, columns: spec.columns, output: "", truncated: false }
    if (!found)
      return {
        ...base,
        status: "not_installed",
        detail: "Client not found on the backend PATH; it may be installed elsewhere.",
      }
    const executable = await fs.realpath(found).catch(() => undefined)
    if (!executable || !(await administratorOwned(executable).catch(() => false)))
      return {
        ...base,
        executable: found,
        status: "restricted",
        detail:
          "Detected a user-writable executable. Automatic host queries require an administrator-owned installation; use an explicitly approved command for this installation.",
      }
    return new Promise((resolve) => {
      const child = spawn(executable, [...spec.args], {
        cwd: os.tmpdir(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      })
      const chunks: Buffer[] = []
      let size = 0
      let truncated = false
      let timedOut = false
      const stop = () => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
          else child.kill()
        } catch {
          child.kill()
        }
      }
      signal?.addEventListener("abort", stop, { once: true })
      if (signal?.aborted) stop()
      const capture = (chunk: Buffer) => {
        const remaining = Math.max(0, MAX_OUTPUT - size)
        if (chunk.length > remaining) truncated = true
        if (remaining) chunks.push(chunk.subarray(0, remaining))
        size += Math.min(chunk.length, remaining)
      }
      child.stdout.on("data", capture)
      child.stderr.on("data", capture)
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, TIMEOUT)
      child.once("error", (error) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", stop)
        resolve({ ...base, executable, status: "error", detail: error.message })
      })
      child.once("close", (code) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", stop)
        const output = OpenScience.redactSecrets(Buffer.concat(chunks).toString("utf8")).trim()
        resolve({
          ...base,
          executable,
          status: timedOut ? "timeout" : classify(code, output),
          output,
          truncated,
          ...(timedOut
            ? {
                detail:
                  "Read-only query exceeded 8 seconds. The service remains available; retry when the scheduler responds.",
              }
            : {}),
        })
      })
    })
  }

  export async function query(command: string, args: string[], signal?: AbortSignal) {
    validateQuery(command, args)
    signal?.throwIfAborted()
    return probe({ id: command, command, args, columns: "Native status output" }, await probeEnvironment(), signal)
  }

  export function limits(input: {
    cpu: number
    total: number
    free: number
    quota?: string
    memory?: string
    used?: string
  }) {
    const [quota, period] = (input.quota ?? "").trim().split(/\s+/).map(Number)
    const limited = Number(input.memory?.trim())
    const limit = Number.isFinite(limited) && limited > 0 && limited < input.total ? limited : undefined
    const used = Number(input.used?.trim())
    return {
      cpu: Number.isFinite(quota) && quota > 0 && period > 0 ? Math.min(input.cpu, quota / period) : input.cpu,
      memory: {
        total: input.total,
        available: limit ? Math.min(input.free, Math.max(0, limit - (Number.isFinite(used) ? used : 0))) : input.free,
        ...(limit ? { limit } : {}),
      },
    }
  }

  async function read() {
    const env = await probeEnvironment()
    const text = (file: string) => fs.readFile(file, "utf8").catch(() => "")
    const [checks, release, cgroup, quota, memory, used] = await Promise.all([
      Promise.all(
        probes.map((spec) =>
          probe(spec, env).catch((error): Check => ({
            id: spec.id,
            command: spec.command,
            columns: spec.columns,
            status: "error",
            output: "",
            truncated: false,
            detail: error instanceof Error ? error.message : String(error),
          })),
        ),
      ),
      text("/proc/sys/kernel/osrelease"),
      text("/proc/1/cgroup"),
      text("/sys/fs/cgroup/cpu.max").then(
        async (value) =>
          value ||
          `${await text("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")} ${await text("/sys/fs/cgroup/cpu/cpu.cfs_period_us")}`,
      ),
      text("/sys/fs/cgroup/memory.max").then(
        async (value) => value || (await text("/sys/fs/cgroup/memory/memory.limit_in_bytes")),
      ),
      text("/sys/fs/cgroup/memory.current").then(
        async (value) => value || (await text("/sys/fs/cgroup/memory/memory.usage_in_bytes")),
      ),
    ])
    const capped = limits({
      cpu: os.availableParallelism(),
      total: os.totalmem(),
      free: os.freemem(),
      quota,
      memory,
      used,
    })
    const container =
      !!process.env.container ||
      /docker|containerd|kubepods|lxc/i.test(cgroup) ||
      (await fs.stat("/.dockerenv").then(
        () => true,
        () => false,
      ))
    return Info.parse({
      authority: process.env.OPENSCIENCE_REMOTE_WORKER === "1" ? "remote" : "local",
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      kind: container ? "container" : /microsoft|wsl/i.test(release) ? "wsl" : "host",
      sampledAt: Date.now(),
      cpu: { logical: os.cpus().length, available: capped.cpu },
      memory: capped.memory,
      schedulers: checks.filter((check) => ["slurm", "slurm_queue", "pbs", "lsf", "sge"].includes(check.id)),
      accelerators: checks.filter((check) => ["nvidia", "amd"].includes(check.id)),
      runtimes: ["conda", "mamba", "micromamba", "python3", "python", "R", "node", "julia"].flatMap((name) => {
        const executable = Bun.which(name)
        return executable ? [{ name, executable }] : []
      }),
      notes: [
        "CPU, memory and accelerators describe the connected node/container, not an entire cluster or an allocation promised to this session.",
        "Scheduler and GPU probes are fixed read-only host queries. They do not submit jobs, modify environments, or change project sandbox/network policy.",
        "A missing scheduler is normal on a standalone host. A detected but restricted, timed-out or broken client is not evidence that the cluster is empty.",
        "Client detection uses the backend PATH. Compatibility wrappers do not imply separate clusters; a client outside PATH may need environment configuration before it is detected.",
      ],
    })
  }
  let cached: { at: number; value: Promise<Info> } | undefined
  export function inspect() {
    if (cached && Date.now() - cached.at < 15_000) return cached.value
    const value = read()
    cached = { at: Date.now(), value }
    void value.catch(() => {
      if (cached?.value === value) cached = undefined
    })
    return value
  }
}
