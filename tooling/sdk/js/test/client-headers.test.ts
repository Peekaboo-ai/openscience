import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { describe, test } from "node:test"
import { createOpenScienceClient } from "../src/v2/client.js"
import { createOpenScienceClient as createLegacyClient } from "../src/client.js"

for (const [version, create] of [
  ["v1", createLegacyClient],
  ["v2", createOpenScienceClient],
] as const) {
  test(`${version} transports Unicode directories through real HTTP headers`, async () => {
    const directory = "C:\\Users\\科研 用户\\project %20\\workspace"
    const server = createServer((request, response) => {
      assert.equal(decodeURIComponent(String(request.headers["x-openscience-directory"])), directory)
      assert.equal(request.headers["x-openscience-project"], "prj_unicode")
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ directory }))
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    try {
      const address = server.address()
      assert.ok(address && typeof address === "object")
      const client = create({ baseUrl: `http://127.0.0.1:${address.port}`, directory, projectID: "prj_unicode" })
      const response = await client.path.get({ throwOnError: true })
      assert.equal(response.data?.directory, directory)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}

describe("createOpenScienceClient", () => {
  test("asks every request for JSON so an unknown route cannot answer with the UI shell", async () => {
    const requests: Request[] = []
    const client = createOpenScienceClient({
      baseUrl: "http://client.test",
      projectID: "prj_test",
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        requests.push(request)
        return Response.json({ healthy: true, version: "test" })
      },
    })
    await client.global.health()
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.headers.get("accept"), "application/json")
    assert.equal(requests[0]!.headers.get("x-openscience-project"), "prj_test")
  })

  test("an explicit Accept header still wins", async () => {
    const requests: Request[] = []
    const client = createOpenScienceClient({
      baseUrl: "http://client.test",
      headers: { accept: "text/event-stream" },
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        requests.push(request)
        return Response.json({ healthy: true, version: "test" })
      },
    })
    await client.global.health()
    assert.equal(requests[0]!.headers.get("accept"), "text/event-stream")
  })
})
