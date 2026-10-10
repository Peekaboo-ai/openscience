import assert from "node:assert/strict"

const [gateway, projectID, expectedVersion] = process.argv.slice(2)
if (!gateway || !projectID || !expectedVersion)
  throw new Error("Usage: verify-remote-capabilities.ts <gateway> <projectID> <expectedVersion>")

async function request(route: string) {
  const response = await fetch(gateway.replace(/\/$/, "") + route, {
    headers: { "x-openscience-project": projectID },
    proxy: "",
    signal: AbortSignal.timeout(60_000),
  })
  assert.ok(response.ok, `${route}: HTTP ${response.status}`)
  assert.ok(response.headers.get("content-type")?.includes("application/json"), `${route}: expected JSON`)
  return response.json()
}

// A healthy SSH bridge can still serve an outdated runtime. Verify the deployed
// version and actual project capabilities, not just the local server's health.
const health = await request("/global/health")
assert.equal(health.healthy, true)
assert.equal(health.version, expectedVersion, "Remote runtime has not been upgraded")
const [commands, skills, specialists, catalog] = await Promise.all([
  request("/command"),
  request("/skill"),
  request("/settings/specialists"),
  request("/settings/specialists/catalog"),
])
assert.ok(Array.isArray(commands))
assert.ok(Array.isArray(skills))
const customize = commands.filter((command: { name: string }) => command.name.toLowerCase() === "customize")
assert.equal(customize.length, 1, "Expected exactly one customize command")
assert.equal(customize[0].name, "customize")
assert.equal(customize[0].template, "/customize $ARGUMENTS")
assert.equal(skills.filter((skill: { name: string }) => skill.name === "customize").length, 1)
assert.ok(Number.isInteger(specialists.revision))
assert.ok(Array.isArray(specialists.profiles))
assert.ok(specialists.profiles.some((profile: { name: string }) => profile.name === "biology"))
assert.ok(Array.isArray(catalog.skills))
assert.ok(Array.isArray(catalog.connectors))
assert.ok(catalog.skills.some((skill: { name: string }) => skill.name === "customize"))
console.log(
  JSON.stringify({
    projectID,
    version: health.version,
    customize: "passed",
    skills: skills.length,
    specialists: specialists.profiles.length,
    catalog: "passed",
  }),
)
