import { expect, test } from "bun:test"
import path from "node:path"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { createMemoryRoutes } from "../../src/server/routes/settings/memory"
import { createMemoryService } from "../../src/memory"
import { memoryRepository } from "../../src/memory/repository"
import { tmpdir } from "../fixture/fixture"

test("memory routes provide durable CRUD, preview, conflict detection and safe validation", async () => {
  await using tmp = await tmpdir()
  const service = createMemoryService(memoryRepository(path.join(tmp.path, "memory.json")))
  const app = new Hono().route("/settings/memory", createMemoryRoutes(service))
  const request = (route: string, method = "GET", body?: unknown) =>
    app.request(`/settings/memory${route}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const initial = await request("")
  expect(initial.status).toBe(200)
  expect(initial.headers.get("cache-control")).toBe("no-store")
  const input = {
    title: "Reporting",
    content: "Include uncertainty.",
    scope: { kind: "global" },
    categoryID: "research",
  }
  const saved = await request("/notes", "POST", { revision: 0, note: input })
  expect(saved.status).toBe(200)
  const note = (await saved.json()).notes[0]
  expect((await (await request("/preview")).json()).system).toContain(input.content)
  expect((await request("", "PATCH", { revision: 0, enabled: false })).status).toBe(409)
  expect(
    (await request("/notes", "POST", { revision: 1, note: { ...input, content: "x".repeat(4_001) } })).status,
  ).toBe(400)
  expect((await request("/preview?sessionID=ses_unknown")).status).toBe(400)
  expect((await request("/catalog?projectID=..%2Fprivate")).status).toBe(400)
  expect(
    (
      await request("/notes", "POST", {
        revision: 1,
        note: { ...input, scope: { kind: "project", projectID: "prj_missing" } },
      })
    ).status,
  ).toBe(404)
  const paused = await request("", "PATCH", { revision: 1, enabled: false })
  expect(paused.status).toBe(200)
  expect((await (await request("/preview")).json()).included).toEqual([])
  expect((await request("/notes/delete", "POST", { revision: 2, ids: [note.id] })).status).toBe(200)
  expect((await service.read()).notes).toEqual([])
})

test("mounted memory routes retain their generated SDK and OpenAPI contract", async () => {
  const spec = await generateSpecs(new Hono().route("/settings/memory", createMemoryRoutes()))
  expect(spec.paths["/settings/memory"].get?.operationId).toBe("settings.memory.get")
  expect(spec.paths["/settings/memory/preview"].get?.operationId).toBe("settings.memory.preview")
  expect(spec.paths["/settings/memory/notes/{id}"].put?.operationId).toBe("settings.memory.updateNote")
  expect(spec.components?.schemas?.MemoryStore).toBeDefined()
})
