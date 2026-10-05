import { expect, test } from "bun:test"
import { telemetryArguments } from "../../src/compute/telemetry-probe"

const python = Bun.which(process.platform === "win32" ? "python" : "python3")
test.skipIf(!python)("both collector hops execute with ASCII command arguments in the C locale", async () => {
  const args = telemetryArguments({ scheduler: "slurm", jobID: "41" })
  const nested = JSON.parse(args.at(-1)!) as { source: string }
  for (const code of [args[2], nested.source]) {
    // ASCII 启动参数是旧版 Python 在 C locale 下的进程边界约束，不依赖节点安装中文语言包。
    expect(Buffer.from(code, "ascii").toString("ascii")).toBe(code)
    const process = Bun.spawn(
      [python!, "-I", "-X", "utf8=0", "-c", code, JSON.stringify({ mode: "host", probes: [] })],
      {
        env: { ...globalThis.process.env, LANG: "C", LC_ALL: "C", PYTHONCOERCECLOCALE: "0" },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const timer = setTimeout(() => process.kill(), 5000)
    try {
      const [out, err, status] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      expect(err).toBe("")
      expect(status).toBe(0)
      const report = JSON.parse(out)
      expect(report.state).toBe("live")
      expect(report.sample.cpu.cores).toBeGreaterThan(0)
      expect(Array.isArray(report.sample.probes)).toBe(true)
    } finally {
      clearTimeout(timer)
    }
  }
})
