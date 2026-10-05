import type { SettingsComputeMonitorResponse } from "@synsci/sdk/v2/client"

export type MonitorReport = SettingsComputeMonitorResponse
export type MonitorSample = NonNullable<MonitorReport["sample"]> & { gapBefore?: boolean }
export const percentLabel = (value: number | null | undefined) => (value == null ? "—" : `${value.toFixed(1)}%`)
export const memoryPercent = (memory: MonitorSample["memory"]) =>
  memory.used !== null && memory.total !== null && memory.total > 0
    ? Math.min(100, (memory.used / memory.total) * 100)
    : null
export const memoryLabel = (used: number | null, total: number | null) => {
  const format = (value: number | null) => (value === null ? "—" : (value / 1024 ** 3).toFixed(1))
  return `${format(used)} / ${format(total)} GiB`
}

export function appendSample(previous: MonitorSample[], next: MonitorSample) {
  if (previous.length && previous[previous.length - 1].sampledAt >= next.sampledAt) return previous
  return [...previous.filter((sample) => sample.sampledAt >= next.sampledAt - 15 * 60_000), next].slice(-181)
}

export function sampleScope(sample: MonitorSample | undefined) {
  if (!sample) return ""
  return JSON.stringify([
    sample.hostname,
    sample.acceleratorScope?.kind ?? "host",
    sample.acceleratorScope?.jobID ?? "",
    sample.acceleratorScope?.expectedDevices ?? null,
    sample.devices.map((device) => device.id).sort(),
  ])
}

export function metricPath(
  points: { time: number; value: number | null; gapBefore?: boolean }[],
  start: number,
  end: number,
) {
  const range = Math.max(1, end - start)
  let previous: number | undefined
  return points
    .map((point) => {
      if (point.value === null || !Number.isFinite(point.value) || point.time < start || point.time > end) {
        previous = undefined
        return ""
      }
      const move = previous === undefined || point.gapBefore === true
      previous = point.time
      return `${move ? "M" : "L"}${(8 + ((point.time - start) / range) * 284).toFixed(2)},${(88 - Math.max(0, Math.min(100, point.value)) * 0.78).toFixed(2)}`
    })
    .filter(Boolean)
    .join(" ")
}

export function parseMonitor(value: unknown): MonitorReport {
  const report = value as MonitorReport | null
  const metric = (value: unknown, maximum = Infinity) =>
    value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum)
  const sample = report?.sample
  const scope = sample?.acceleratorScope
  const validScope =
    scope === undefined ||
    (scope &&
      ["host", "allocation", "unavailable"].includes(scope.kind) &&
      (scope.jobID === undefined || typeof scope.jobID === "string") &&
      (scope.reason === undefined || typeof scope.reason === "string") &&
      (scope.expectedDevices === undefined || (Number.isInteger(scope.expectedDevices) && scope.expectedDevices >= 0)))
  const validSample =
    sample === null ||
    (sample &&
      Number.isFinite(sample.sampledAt) &&
      typeof sample.hostname === "string" &&
      Number.isFinite(sample.cpu?.cores) &&
      metric(sample.cpu?.utilization, 100) &&
      metric(sample.memory?.used) &&
      metric(sample.memory?.total) &&
      Array.isArray(sample.issues) &&
      sample.issues.every((issue) => typeof issue === "string") &&
      Array.isArray(sample.devices) &&
      sample.devices.every(
        (device) =>
          device &&
          typeof device.id === "string" &&
          typeof device.name === "string" &&
          typeof device.source === "string" &&
          ["GPU", "DCU", "TPU"].includes(device.kind) &&
          metric(device.utilization, 100) &&
          metric(device.memoryPercent, 100) &&
          metric(device.memoryUsed) &&
          metric(device.memoryTotal) &&
          metric(device.temperature) &&
          metric(device.power),
      ))
  if (
    !report ||
    !Array.isArray(report.targets) ||
    !Array.isArray(report.nodes) ||
    !Array.isArray(report.issues) ||
    !Number.isFinite(report.intervalMs) ||
    report.intervalMs <= 0 ||
    typeof report.selected !== "string" ||
    !validSample ||
    (report.state === "live" && !sample) ||
    !report.targets.every((target) => target && typeof target.id === "string" && typeof target.label === "string") ||
    !report.nodes.every((node) => typeof node === "string") ||
    !report.issues.every((issue) => typeof issue === "string") ||
    !["live", "queued", "unavailable", "finished"].includes(report.state)
  ) {
    throw new Error("Resource monitoring returned an invalid response.")
  }
  if (!sample) return report
  const target = report.targets.find((target) => target.id === report.selected)
  const jobID = target?.jobID ?? /^(?:slurm|pbs):(.+)$/.exec(report.selected)?.[1]
  const scheduled = target?.kind === "slurm" || target?.kind === "pbs" || /^(?:slurm|pbs):/.test(report.selected)
  const unavailable = (reason: string): MonitorReport => ({
    ...report,
    sample: {
      ...sample,
      devices: [],
      acceleratorScope: { kind: "unavailable", ...(typeof jobID === "string" ? { jobID } : {}), reason },
    },
  })
  if (!validScope) return unavailable("Accelerator allocation metadata could not be verified.")
  if (scheduled && (!scope || scope.kind === "host")) {
    // 旧后端没有作业分配范围，不能把整机可见卡当作该作业的卡显示。
    return unavailable("Update this host's backend to identify the accelerators allocated to this job.")
  }
  if (scope?.kind === "unavailable") return { ...report, sample: { ...sample, devices: [] } }
  if (
    scope?.kind === "allocation" &&
    (!scope.jobID?.trim() ||
      (scheduled && (typeof jobID !== "string" || !jobID.trim())) ||
      (jobID !== undefined && scope.jobID !== jobID) ||
      scope.expectedDevices === undefined ||
      scope.expectedDevices !== sample.devices.length)
  ) {
    return unavailable("Accelerator telemetry does not match this job's verified allocation. Retrying automatically…")
  }
  if (
    sample.devices.some((device) => !device.id.trim()) ||
    new Set(sample.devices.map((device) => device.id)).size !== sample.devices.length
  ) {
    return unavailable("Accelerator identities could not be verified. Retrying automatically…")
  }
  return report
}
