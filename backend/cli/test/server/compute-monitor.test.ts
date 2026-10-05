import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ComputeSettingsRoutes } from "../../src/server/routes/settings/compute"
import { ComputeTelemetry } from "../../src/compute/telemetry-schema"

test("monitor endpoint samples the connected host and validates target selection", async () => {
  await using directory = await tmpdir()
  const route = ComputeSettingsRoutes()
  const query = `directory=${encodeURIComponent(directory.path)}`
  const response = await route.request(`/monitor?${query}&target=host`)
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const result = ComputeTelemetry.Report.parse(await response.json())
  expect(result.selected).toBe("host")
  expect(result.state).toBe("live")
  expect(result.sample!.cpu.cores).toBeGreaterThan(0)
  expect(result.targets.some((target) => target.id === "host")).toBe(true)
  const missing = await route.request(`/monitor?${query}&target=slurm:unknown`)
  expect((await missing.json()).state).toBe("finished")
  const bad = await route.request(`/monitor?${query}&node=-oProxyCommand%3Devil`)
  expect(bad.status).toBe(400)
}, 30000)
