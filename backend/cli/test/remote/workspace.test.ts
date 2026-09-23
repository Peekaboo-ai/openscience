import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { PassThrough } from "node:stream"
import path from "node:path"
import fs from "node:fs/promises"
import { channel, forwardedHeaders, remoteURL } from "../../src/remote/protocol"
import { RemoteClient } from "../../src/remote/client"
import { Target, quote, decodeOutput } from "../../src/remote/transport"
import { RemoteWorkspaces } from "../../src/remote/registry"
import { WorkspaceRoutes, RemoteWorkspaceRoutes } from "../../src/server/routes/workspaces"
import { tmpdir } from "../fixture/fixture"

test("remote boundaries reject alternate origins and keep local credentials out of forwarding", () => {
  for (const value of ["https://evil.test/", "//evil.test/x", "/\\evil.test"])
    expect(() => remoteURL("http://127.0.0.1:1234", value)).toThrow()
  expect(remoteURL("http://127.0.0.1:1234", "/session?project=prj_remote").pathname).toBe("/session")
  expect(
    forwardedHeaders(
      new Headers({
        authorization: "secret",
        cookie: "secret",
        "x-openscience-internal": "secret",
        "x-openscience-project": "prj_remote",
      }),
    ),
  ).toEqual({ "x-openscience-project": "prj_remote" })
  expect(Target.safeParse({ kind: "docker", container: "--privileged" }).success).toBe(false)
  expect(Target.safeParse({ kind: "wsl", distro: "Ubuntu\ncommand" }).success).toBe(false)
  expect(quote("a'b")).toBe("'a'\"'\"'b'")
  expect(
    decodeOutput(Buffer.concat([Buffer.from("WSL 代理提示\r\n", "utf16le"), Buffer.from("sh: command failed\n")])),
  ).toBe("WSL 代理提示\r\nsh: command failed\n")
})

test("framing handles banners, split chunks and Unicode without mixing requests", async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const values: string[] = []
  let error: Error | undefined
  const wire = channel(
    input,
    output,
    (frame) => values.push(frame.data ?? ""),
    (value) => {
      error = value
    },
  )
  output.pipe(input)
  input.write("SSH banner\n")
  await Promise.all([
    wire.send({ id: "a", type: "data", data: "研究" }),
    wire.send({ id: "b", type: "data", data: "second" }),
  ])
  expect(values).toEqual(["研究", "second"])
  expect(error).toBeUndefined()
  input.destroy()
  output.destroy()
})

test("task workspace is durable and separate from explicitly opened project folders", async () => {
  await using folder = await tmpdir()
  const routes = WorkspaceRoutes()
  const task = await (await routes.request("/task", { method: "POST" })).json()
  const other = await (await routes.request("/task", { method: "POST" })).json()
  expect(task.projectID).toBe(other.projectID)
  expect(task.id).not.toBe(other.id)
  const body = JSON.stringify({ name: "Remote folder fixture", directory: folder.path })
  const first = await (
    await routes.request("/open", { method: "POST", headers: { "content-type": "application/json" }, body })
  ).json()
  const second = await (
    await routes.request("/open", { method: "POST", headers: { "content-type": "application/json" }, body })
  ).json()
  expect(first.project.id).toBe(second.project.id)
  expect(first.project.id).not.toBe(task.projectID)
  const catalog = await (await routes.request("/catalog")).json()
  expect(catalog.tasksProjectID).toBe(task.projectID)
  expect(catalog.projects.some((item: { id: string }) => item.id === first.project.id)).toBe(true)
})

test("offline bookmarks never fall back to a local API and cancellation survives a late connect attempt", async () => {
  const bookmark = await RemoteWorkspaces.create({
    name: "Disconnected fixture",
    target: { kind: "ssh", host_id: "missing-host" },
  })
  try {
    expect(() => RemoteWorkspaces.client(bookmark.id)).toThrow("disconnected")
    const renamed = await RemoteWorkspaces.bind(bookmark.id, "/remote/folder", "prj_fixture", "Chosen project name")
    expect(renamed.name).toBe("Chosen project name")
    const response = await RemoteWorkspaceRoutes().request(`/${bookmark.id}/api/global/health`)
    expect(response.ok).toBe(false)
    await RemoteWorkspaces.connect(bookmark.id)
    RemoteWorkspaces.disconnect(bookmark.id)
    await Bun.sleep(50)
    expect((await RemoteWorkspaces.list()).find((item) => item.id === bookmark.id)?.state).toBe("disconnected")
  } finally {
    await RemoteWorkspaces.remove(bookmark.id)
  }
})

test("real remote worker serves isolated backend requests and streaming events over stdio", async () => {
  await using root = await tmpdir()
  const proc = spawn(
    process.execPath,
    ["--conditions=browser", path.resolve(import.meta.dir, "../../src/bootstrap.ts"), "workspace-bridge"],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENSCIENCE_TEST_HOME: root.path,
        XDG_DATA_HOME: path.join(root.path, "data"),
        XDG_CONFIG_HOME: path.join(root.path, "config"),
        XDG_CACHE_HOME: path.join(root.path, "cache"),
        XDG_STATE_HOME: path.join(root.path, "state"),
      },
    },
  )
  const exited = new Promise<void>((resolve) => proc.once("close", () => resolve()))
  const client = new RemoteClient(proc, () => undefined)
  try {
    await client.ready
    const health = await client.request("/global/health").then((res) => res.json())
    expect(health.healthy).toBe(true)
    const [a, b] = await Promise.all([
      client.request("/workspace/catalog").then((res) => res.json()),
      client.request(`/workspace/directories?path=${encodeURIComponent(root.path)}`).then((res) => res.json()),
    ])
    expect(a.projects).toEqual([])
    expect(b.directory).toBe(await fs.realpath(root.path))
    const task = await client.request("/workspace/task", { method: "POST" }).then((res) => res.json())
    expect(task.directory.startsWith(root.path)).toBe(true)
    const folder = path.join(root.path, "selected-folder")
    await fs.mkdir(folder)
    const bytes = Buffer.from([0, 1, 127, 128, 254, 255])
    await fs.writeFile(path.join(folder, "binary.dat"), bytes)
    const opened = await client
      .request("/workspace/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Selected folder", directory: folder }),
      })
      .then((res) => res.json())
    const headers = { "x-openscience-project": opened.project.id, "content-type": "application/json" }
    const session = await client.request("/session", { method: "POST", headers, body: "{}" }).then((res) => res.json())
    const filesystem = await client.request(`/session/${session.id}/filesystem`, { headers }).then((res) => res.json())
    expect(filesystem.toolDirectory).toBe(await fs.realpath(folder))
    const raw = await client.request(
      `/file/raw?path=${encodeURIComponent(path.join(folder, "binary.dat"))}&sessionID=${session.id}`,
      { headers },
    )
    expect(raw.status).toBe(200)
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(bytes)
    const range = await client.request(
      `/file/raw?path=${encodeURIComponent(path.join(folder, "binary.dat"))}&sessionID=${session.id}`,
      { headers: { ...headers, range: "bytes=2-4" } },
    )
    expect(range.status).toBe(206)
    expect(range.headers.get("content-range")).toBe("bytes 2-4/6")
    expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(2, 5))
    const streamAbort = new AbortController()
    const stream = await client.request("/global/event", { signal: streamAbort.signal })
    expect(stream.headers.get("content-type")).toContain("text/event-stream")
    const reader = stream.body!.getReader()
    const chunk = await reader.read()
    expect(new TextDecoder().decode(chunk.value)).toContain("server.connected")
    streamAbort.abort()
    expect((await client.request("/global/health")).ok).toBe(true)
    const cancelled = Promise.withResolvers<void>()
    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        request.signal.addEventListener("abort", () => cancelled.resolve(), { once: true })
        return client.request(new URL(request.url).pathname, { signal: request.signal })
      },
    })
    try {
      const navigation = new AbortController()
      const response = await fetch(new URL("/global/event", gateway.url), { signal: navigation.signal, proxy: "" })
      expect(new TextDecoder().decode((await response.body!.getReader().read()).value)).toContain("server.connected")
      navigation.abort()
      await cancelled.promise
      expect((await fetch(new URL("/global/health", gateway.url), { proxy: "" })).ok).toBe(true)
    } finally {
      await gateway.stop(true)
    }
    const offline = await client.request("/global/event")
    const offlineReader = offline.body!.getReader()
    await offlineReader.read()
    client.close()
    await expect(offlineReader.read()).rejects.toThrow("disconnected")
  } finally {
    client.close()
    await exited
  }
}, 60_000)
