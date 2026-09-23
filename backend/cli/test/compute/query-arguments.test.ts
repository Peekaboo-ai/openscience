import { expect, test } from "bun:test"
import { validateQuery } from "../../src/compute/query-arguments"
import { ComputeEnvironment } from "../../src/compute/environment"

test("cluster terminal queries accept native status filters and formatting", () => {
  for (const [command, args] of [
    ["sinfo", []],
    ["sinfo", ["-Nel", "-p", "cpu,gpu", "--format=%P|%a|%D"]],
    ["squeue", ["--me", "-o", "%.18i %.8T", "--states=RUNNING"]],
    ["pbsnodes", ["-a"]],
    ["bhosts", ["-w"]],
    ["qhost", ["-h", "node01"]],
  ] as const)
    expect(() => validateQuery(command, [...args])).not.toThrow()
})

test("cluster terminal queries reject mutations, plugins, configuration injection and unbounded polling", async () => {
  for (const [command, args] of [
    ["sbatch", ["job.sh"]],
    ["scontrol", ["shutdown"]],
    ["__proto__", []],
    ["squeue", ["--iterate=1"]],
    ["squeue", ["--json=plugin"]],
    ["sinfo", ["--config=/tmp/config"]],
    ["pbsnodes", ["-o", "node01"]],
    ["sinfo", ["-p"]],
    ["sinfo", ["-o", "bad\nformat"]],
  ] as const)
    await expect(ComputeEnvironment.query(command, [...args])).rejects.toThrow()
})
