import { ComputeTelemetry } from "./telemetry-schema"

export const acceleratorProbes = [
  {
    id: "nvidia",
    command: "nvidia-smi",
    args: [
      "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
      "--format=csv,noheader,nounits",
    ],
  },
  {
    id: "hygon",
    command: "hy-smi",
    args: ["--showuse", "--showmeminfo", "vram", "--showtemp", "--showpower", "--json"],
  },
  {
    id: "amd",
    command: "rocm-smi",
    args: ["--showproductname", "--showuse", "--showmeminfo", "vram", "--showtemp", "--showpower", "--json"],
  },
  { id: "tpu", command: "tpu-info", args: [] },
] as const

export type Probe = { id: string; command: string; status: string; output: string; detail?: string }
const clean = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
const number = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value !== "string" || !/^\s*\d/.test(value)) return null
  const parsed = Number.parseFloat(value.replace(/,/g, ""))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
const percent = (value: unknown) => {
  const parsed = number(value)
  return parsed !== null && parsed <= 100 ? parsed : null
}
const ratio = (used: number | null, total: number | null) =>
  used !== null && total !== null && total > 0 ? Math.min(100, (used / total) * 100) : null
const base = (
  id: string,
  name: string,
  source: string,
  kind: ComputeTelemetry.Device["kind"],
): ComputeTelemetry.Device => ({
  id: `${source}:${id}`,
  name,
  source,
  kind,
  utilization: null,
  memoryUsed: null,
  memoryTotal: null,
  memoryPercent: null,
  temperature: null,
  power: null,
})

function nvidia(output: string) {
  return clean(output)
    .split(/\r?\n/)
    .flatMap((line) => {
      const values = line.match(/(?:"(?:[^"]|"")*"|[^,])+/g)?.map((value) => value.trim().replace(/^"|"$/g, "")) ?? []
      if (values.length !== 7 || !/^\d+$/.test(values[0])) return []
      const used = number(values[3])
      const total = number(values[4])
      return [
        {
          ...base(values[0], values[1], "nvidia-smi", "GPU"),
          utilization: percent(values[2]),
          memoryUsed: used === null ? null : used * 1024 ** 2,
          memoryTotal: total === null ? null : total * 1024 ** 2,
          memoryPercent: ratio(used, total),
          temperature: number(values[5]),
          power: number(values[6]),
        },
      ]
    })
}

function rocm(output: string, source: string) {
  const text = clean(output)
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  const payload = text.slice(start, end + 1)
  // 部分 hyhal 客户端把相邻功耗字段输出为两个相接的字符串，只修复这一明确的分隔符缺陷。
  const normalized =
    source === "hy-smi"
      ? payload.replace(/"(\d+(?:\.\d+)?)"\s*(?="(?:Average|Current|Socket|Power)[^"]*"\s*:)/g, '"$1",')
      : payload
  const json: unknown = start >= 0 ? JSON.parse(normalized) : {}
  if (!json || typeof json !== "object" || Array.isArray(json)) return []
  return Object.entries(json).flatMap(([key, value]) => {
    if (!/^(card|gpu|dcu)\d+$/i.test(key) || !value || typeof value !== "object") return []
    const fields = Object.entries(value as Record<string, unknown>)
    const field = (pattern: RegExp) => fields.find(([label]) => pattern.test(label))?.[1]
    const memory = (pattern: RegExp) => {
      const entry = fields.find(([label]) => pattern.test(label))
      const value = number(entry?.[1])
      if (value === null) return null
      return value * (/\(MiB\)/i.test(entry![0]) ? 1024 ** 2 : /\(GiB\)/i.test(entry![0]) ? 1024 ** 3 : 1)
    }
    const used = memory(/VRAM.*(?:Used|Usage).*\((?:B|MiB|GiB)\)/i)
    const total = memory(/VRAM.*Total(?!.*(?:Used|Usage)).*\((?:B|MiB|GiB)\)/i)
    const label = field(/Card (?:series|model)|Product Name|Device Name/i)
    const kind = source === "hy-smi" ? "DCU" : "GPU"
    const id = key.replace(/\D/g, "")
    return [
      {
        ...base(id, typeof label === "string" ? label : `${kind} ${id}`, source, kind),
        utilization: percent(field(/(?:GPU|DCU|HCU) use|(?:GPU|DCU|HCU) Utilization/i)),
        memoryUsed: used,
        memoryTotal: total,
        memoryPercent: ratio(used, total) ?? percent(field(/VRAM.*(?:%|percent)/i)),
        temperature: number(field(/Temperature.*(?:edge|junction)|Temperature.*\(C\)/i)),
        power: number(field(/(?:Average|Current|Socket).*Power|Power.*\(W\)/i)),
      },
    ]
  })
}

function hygonTable(output: string) {
  const lines = clean(output).split(/\r?\n/)
  const header = lines.findIndex((line) => /(?:DCU|GPU)%/.test(line) && /VRAM%/.test(line))
  if (header < 0) return []
  const columns = lines[header].trim().split(/\s+/)
  return lines.slice(header + 1).flatMap((line) => {
    const values = line.trim().split(/\s+/)
    if (!/^\d+$/.test(values[0]) || values.length < columns.length) return []
    const at = (pattern: RegExp) => values[columns.findIndex((key) => pattern.test(key))]
    return [
      {
        ...base(values[0], `DCU ${values[0]}`, "hy-smi", "DCU"),
        utilization: percent(at(/^(DCU|GPU)%$/)),
        memoryPercent: percent(at(/^VRAM%$/)),
        temperature: number(at(/^Temp$/)),
        power: number(at(/^(AvgPwr|Power)$/)),
      },
    ]
  })
}

function tpu(output: string) {
  const text = clean(output)
  const model = text.match(/Accelerator type:\s*(\S+)/)?.[1] ?? "TPU"
  const section =
    text.split(/TPU Runtime Utilization|TPU HBM Usage/)[1]?.split(/TensorCore|TPU Buffer|TPU Inbound/)[0] ?? ""
  return section.split(/\r?\n/).flatMap((line) => {
    const match = line.match(
      /[|│]\s*(\d+)\s*[|│]\s*([\d.]+)\s*GiB\s*\/\s*([\d.]+)\s*GiB\s*[|│](?:\s*([\d.]+)%\s*[|│])?/,
    )
    if (!match) return []
    const used = Number(match[2]) * 1024 ** 3
    const total = Number(match[3]) * 1024 ** 3
    return [
      {
        ...base(match[1], `${model} · chip ${match[1]}`, "tpu-info", "TPU"),
        utilization: percent(match[4]),
        memoryUsed: used,
        memoryTotal: total,
        memoryPercent: ratio(used, total),
      },
    ]
  })
}

export function devices(probes: Probe[]) {
  const issues: string[] = []
  const found = probes.flatMap((probe) => {
    if (probe.status === "not_installed") return []
    if (probe.status !== "ready") {
      issues.push(`${probe.command}: ${probe.detail || probe.status}`)
      return []
    }
    try {
      const parsed =
        probe.id === "drm"
          ? ComputeTelemetry.Device.array().parse(JSON.parse(probe.output))
          : probe.id === "nvidia"
            ? nvidia(probe.output)
            : probe.id === "tpu"
              ? tpu(probe.output)
              : rocm(probe.output, probe.command)
      const result = parsed.length || probe.id !== "hygon" ? parsed : hygonTable(probe.output)
      if (!result.length)
        issues.push(`${probe.command}: no readable device metrics. Check the driver and monitoring client version.`)
      return result
    } catch {
      const fallback = probe.id === "hygon" ? hygonTable(probe.output) : []
      if (!fallback.length) issues.push(`${probe.command}: device metrics could not be decoded.`)
      return fallback
    }
  })
  const complete = (kind: ComputeTelemetry.Device["kind"]) => {
    const cards = found.filter((item) => item.source === "sysfs" && item.kind === kind)
    return (
      cards.length > 0 &&
      cards.every((item) => item.utilization !== null && item.memoryUsed !== null && item.memoryTotal !== null)
    )
  }
  // 海光兼容安装可能同时提供 rocm-smi，优先保留原生 DCU 标识，避免一张卡显示两次。
  return {
    devices: found.filter((item) => {
      if (["hy-smi", "rocm-smi"].includes(item.source) && complete(item.kind)) return false
      if (
        item.source === "sysfs" &&
        !complete(item.kind) &&
        found.some((entry) => ["hy-smi", "rocm-smi"].includes(entry.source) && entry.kind === item.kind)
      )
        return false
      return item.source !== "rocm-smi" || !found.some((entry) => entry.source === "hy-smi")
    }),
    issues,
  }
}
