import source from "./telemetry-probe.py" with { type: "text" }
import { acceleratorProbes } from "./telemetry-devices"

// 集群的 C locale 和旧版 Python 会拒绝非 ASCII 的 -c 参数；两跳采样都使用同一编码入口。
const bootstrap = `import base64;exec(compile(base64.b64decode('${Buffer.from(source, "utf8").toString("base64")}'), '<compute-monitor>', 'exec'))`

export type NodeSelection = { scheduler: "slurm" | "pbs"; jobID: string; node?: string }
export function telemetryArguments(selection?: NodeSelection) {
  return [
    "-I",
    "-c",
    bootstrap,
    JSON.stringify({
      mode: selection ? "allocation" : "host",
      probes: acceleratorProbes,
      ...(selection ? { ...selection, source: bootstrap } : {}),
    }),
  ]
}

export function telemetryScript(selection?: NodeSelection) {
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`
  return ["/usr/bin/python3", ...telemetryArguments(selection)].map(quote).join(" ")
}
