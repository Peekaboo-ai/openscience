import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import z from "zod"
import { Instance } from "../project/instance"
import { SessionFilesystem } from "../session/filesystem"
import { Session } from "../session"
import { JobBroker } from "./job-broker"
import { ComputeEnvironment } from "./environment"
import { ComputeTelemetry } from "./telemetry-schema"
import { acceleratorProbes, devices, type Probe } from "./telemetry-devices"
import { telemetryArguments, type NodeSelection } from "./telemetry-probe"

export { ComputeTelemetry } from "./telemetry-schema"
const INTERVAL = 5_000
const raw = z.object({
  state: z.enum(["live", "queued", "unavailable", "finished"]),
  nodes: z.string().array().max(256),
  node: z.string().optional(),
  sample: ComputeTelemetry.Sample.omit({ devices: true, issues: true })
    .extend({
      probes: z.array(
        z.object({
          id: z.string(),
          command: z.string(),
          status: z.string(),
          output: z.string(),
          detail: z.string().optional(),
        }),
      ),
    })
    .nullable(),
  issues: z.string().array().optional(),
})
type Reading = Omit<ComputeTelemetry.Report, "targets" | "selected" | "intervalMs">
type Entry = { target: ComputeTelemetry.Target; sample: (node?: string) => Promise<Reading> }

export function cached<T>(limit: number) {
  const entries = new Map<string, { until: number; value: Promise<T> }>()
  return (key: string, ttl: number, read: () => Promise<T>) => {
    const found = entries.get(key)
    if (found && found.until > Date.now()) return found.value
    const started = Date.now()
    const value = Promise.resolve().then(read)
    entries.delete(key)
    entries.set(key, { until: Infinity, value })
    while (entries.size > limit) entries.delete(entries.keys().next().value!)
    void value.then(
      () => {
        // 刷新周期从采样开始计算，慢节点返回后不额外再等待一整个缓存周期。
        if (entries.get(key)?.value === value) entries.set(key, { until: started + ttl, value })
      },
      () => {
        if (entries.get(key)?.value === value) entries.delete(key)
      },
    )
    return value
  }
}

const readings = cached<Reading>(48)
const inventories = cached<{ entries: Entry[]; issues: string[] }>(16)
const unavailable = (message: string): Reading => ({ state: "unavailable", nodes: [], sample: null, issues: [message] })
const details = (error: unknown) => (error instanceof Error ? error.message : String(error))
const inside = (directory: string, root: string) => {
  const relative = path.relative(root, directory)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function slurmTargets(output: string, roots: string[], sessionID?: string): ComputeTelemetry.Target[] {
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      const [id, label, state, , ...rest] = line.trim().split("|")
      const directory = rest.join("|")
      if (!/^\d+(?:_\d+)?$/.test(id) || !directory || !roots.some((root) => inside(directory, root))) return []
      return [
        {
          id: `slurm:${id}`,
          jobID: id,
          label: `${label} · Slurm ${id}`,
          kind: "slurm" as const,
          state: state === "RUNNING" || state === "COMPLETING" ? ("running" as const) : ("queued" as const),
          ...(sessionID && directory.split(/[\\/]/).includes(sessionID) ? { sessionID } : {}),
        },
      ]
    })
    .slice(0, 128)
}

export function pbsTargets(output: string, roots: string[], user: string): ComputeTelemetry.Target[] {
  const parsed = z
    .object({
      Jobs: z.record(
        z.string(),
        z.object({
          Job_Name: z.string().optional(),
          Job_Owner: z.string(),
          job_state: z.string(),
          Variable_List: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
        }),
      ),
    })
    .parse(JSON.parse(output))
  return Object.entries(parsed.Jobs)
    .flatMap(([id, job]) => {
      if (!/^[0-9]+(?:\[[0-9]*\])?(?:\.[A-Za-z0-9_.-]+)?$/.test(id) || job.Job_Owner.split("@")[0] !== user) return []
      const variables = job.Variable_List
      const directory =
        typeof variables === "string" ? variables.match(/(?:^|,)PBS_O_WORKDIR=([^,]+)/)?.[1] : variables?.PBS_O_WORKDIR
      if (
        typeof directory !== "string" ||
        !roots.some((root) => inside(directory, root)) ||
        !["Q", "R", "H", "W", "T"].includes(job.job_state)
      )
        return []
      return [
        {
          id: `pbs:${id}`,
          jobID: id,
          label: `${job.Job_Name ?? id} · PBS ${id}`,
          kind: "pbs" as const,
          state: job.job_state === "R" ? ("running" as const) : ("queued" as const),
        },
      ]
    })
    .slice(0, 128)
}

export function decode(output: string, selection?: NodeSelection): Reading {
  const result = raw.parse(JSON.parse(output))
  const sample = result.sample
  const parsed = sample ? devices(sample.probes) : undefined
  const scope = sample?.acceleratorScope
  // 作业采样必须证明设备归属；旧采集器或错误节点不能悄悄退回整机卡列表。
  const verified =
    !selection ||
    (scope?.kind === "allocation" &&
      scope.jobID === selection.jobID &&
      scope.expectedDevices !== undefined &&
      scope.expectedDevices === parsed?.devices.length &&
      parsed.devices.every((device) => device.id.trim().length > 0) &&
      new Set(parsed.devices.map((device) => device.id)).size === parsed.devices.length)
  const reason = scope?.reason || "The collector could not verify the accelerator allocation for the selected job."
  return {
    state: result.state,
    nodes: result.nodes,
    node: result.node,
    issues: result.issues ?? [],
    sample:
      sample && parsed
        ? ComputeTelemetry.Sample.parse({
            ...sample,
            ...parsed,
            ...(!verified && selection
              ? {
                  devices: [],
                  acceleratorScope: {
                    kind: "unavailable",
                    jobID: selection.jobID,
                    expectedDevices: scope?.expectedDevices,
                    reason,
                  },
                  issues: [...parsed.issues, reason],
                }
              : {}),
          })
        : null,
  }
}

async function query(command: string, args: readonly string[], timeoutMs = 6_000) {
  return ComputeEnvironment.probe(
    { id: command, command, args, columns: "Resource monitor", timeoutMs },
    await ComputeEnvironment.probeEnvironment(),
  )
}

async function accelerators(): Promise<Probe[]> {
  const env = await ComputeEnvironment.probeEnvironment()
  return Promise.all(
    acceleratorProbes.map(async (spec): Promise<Probe> => {
      const read = async () => {
        const result = await ComputeEnvironment.probe({ ...spec, columns: "Device telemetry", timeoutMs: 5_000 }, env)
        if (spec.id !== "hygon" || result.status !== "error") return result
        return ComputeEnvironment.probe({ ...spec, args: [], columns: "Device telemetry", timeoutMs: 5_000 }, env)
      }
      return read().catch((error) => ({
        id: spec.id,
        command: spec.command,
        status: "error",
        output: "",
        detail: details(error),
      }))
    }),
  )
}

const ticks = () =>
  os.cpus().reduce(
    (sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((total, tick) => total + tick, 0),
    }),
    { idle: 0, total: 0 },
  )

export function cpuPercent(before: { total: number; idle: number }, after: { total: number; idle: number }) {
  const elapsed = after.total - before.total
  return elapsed > 0 ? Math.max(0, Math.min(100, 100 * (1 - (after.idle - before.idle) / elapsed))) : null
}

export async function sampleHost(): Promise<Reading> {
  const before = ticks()
  const [probes, memory] = await Promise.all([
    accelerators(),
    fs.readFile("/proc/meminfo", "utf8").catch(() => ""),
    new Promise((resolve) => setTimeout(resolve, 180)),
  ])
  const available = memory.match(/^MemAvailable:\s*(\d+)/m)
  const total = os.totalmem()
  return {
    state: "live",
    nodes: [os.hostname()],
    node: os.hostname(),
    issues: [],
    sample: {
      sampledAt: Date.now(),
      hostname: os.hostname(),
      cpu: { utilization: cpuPercent(before, ticks()), cores: os.cpus().length },
      memory: { total, used: Math.max(0, total - (available ? Number(available[1]) * 1024 : os.freemem())) },
      acceleratorScope: { kind: "host" },
      ...devices(probes),
    },
  }
}

async function allocation(selection: NodeSelection): Promise<Reading> {
  const result = await query("python3", telemetryArguments(selection), 24_000)
  return result.status === "ready"
    ? decode(result.output, selection)
    : unavailable(result.detail || `Node sampling: ${result.status}`)
}

function brokerEntry(job: JobBroker.Job): Entry {
  const scheduler = job.scheduler
  const id = job.remote_id?.replace(/^(slurm|pbs):/, "")
  return {
    target: {
      id: `job:${job.id}`,
      label: `${job.name} · ${job.target_label}`,
      kind: scheduler !== "none" ? scheduler : job.target.kind === "local" ? "host" : job.target.kind,
      state: job.status === "running" ? "running" : "queued",
      sessionID: job.session_id,
      jobID: scheduler !== "none" ? id : job.id,
    },
    sample: async (node) => {
      if (job.target.kind === "modal")
        return unavailable("This managed provider does not expose node telemetry through the current connection.")
      if (scheduler !== "none" && !id) return { state: "queued", nodes: [], sample: null, issues: [] }
      const selection = scheduler === "none" ? undefined : { scheduler, jobID: id!, node }
      if (job.target.kind === "local") return selection ? allocation(selection) : sampleHost()
      return decode(await JobBroker.monitor(job.id, selection), selection)
    },
  }
}

async function discover(sessionID?: string) {
  const roots = [Instance.directory]
  if (sessionID) {
    const session = await Session.get(sessionID)
    if (session.projectID !== Instance.project.id) throw new Error("Session does not belong to this project")
    const state = await SessionFilesystem.state(sessionID)
    roots.push(
      ...state.grants
        .filter(
          (grant) =>
            !grant.time.revoked &&
            grant.scope !== "once" &&
            ["workspace", "project", "api", "permission"].includes(grant.source),
        )
        .map((grant) => grant.path),
    )
  }
  const issues: string[] = []
  const [jobs, slurm] = await Promise.all([
    JobBroker.monitorJobs().catch((error) => {
      issues.push(`Job inventory: ${details(error)}`)
      return []
    }),
    query("squeue", ["--noheader", "--me", "--array", "--format=%i|%j|%T|%N|%Z"]),
  ])
  const entries: Entry[] = [
    { target: { id: "host", label: os.hostname(), kind: "host", state: "running" }, sample: sampleHost },
    ...jobs.map(brokerEntry),
  ]
  if (slurm.status === "ready") {
    for (const target of slurmTargets(slurm.output, roots, sessionID)) {
      if (jobs.some((job) => job.target.kind === "local" && job.remote_id === target.id)) continue
      entries.push({ target, sample: (node) => allocation({ scheduler: "slurm", jobID: target.jobID!, node }) })
    }
  } else if (slurm.status !== "not_installed") issues.push(`Slurm discovery: ${slurm.detail || slurm.status}`)
  else {
    const pbs = await query("qstat", ["-f", "-F", "json"])
    if (pbs.status === "ready") {
      try {
        for (const target of pbsTargets(pbs.output, roots, os.userInfo().username)) {
          entries.push({ target, sample: (node) => allocation({ scheduler: "pbs", jobID: target.jobID!, node }) })
        }
      } catch {
        issues.push("PBS discovery requires a client with JSON status support.")
      }
    } else if (pbs.status !== "not_installed") issues.push(`PBS discovery: ${pbs.detail || pbs.status}`)
  }
  return { entries, issues }
}

export async function monitor(input: {
  sessionID?: string
  target?: string
  node?: string
}): Promise<ComputeTelemetry.Report> {
  const scope = `${Instance.project.id}:${Instance.directory}:${input.sessionID ?? ""}`
  const inventory = await inventories(scope, 15_000, () => discover(input.sessionID))
  const entry = input.target
    ? inventory.entries.find((entry) => entry.target.id === input.target)
    : (inventory.entries.find(
        (entry) => input.sessionID && entry.target.sessionID === input.sessionID && entry.target.state === "running",
      ) ??
      inventory.entries.find(
        (entry) => input.sessionID && entry.target.sessionID === input.sessionID && entry.target.state === "queued",
      ) ??
      inventory.entries.find(
        (entry) => ["slurm", "pbs"].includes(entry.target.kind) && entry.target.state === "running",
      ) ??
      inventory.entries.find(
        (entry) => ["slurm", "pbs"].includes(entry.target.kind) && entry.target.state === "queued",
      ) ??
      inventory.entries[0])
  const reading = entry
    ? await readings(`${scope}:${entry.target.id}:${input.node ?? ""}`, INTERVAL, () =>
        entry.sample(input.node).catch((error) => unavailable(details(error))),
      )
    : {
        state: "finished" as const,
        nodes: [],
        sample: null,
        issues: ["The selected job has finished or is no longer in this project."],
      }
  return {
    ...reading,
    targets: inventory.entries.map((entry) => entry.target),
    selected: entry?.target.id ?? input.target ?? "host",
    intervalMs: INTERVAL,
    issues: [...inventory.issues, ...reading.issues],
  }
}
