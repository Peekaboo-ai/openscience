import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createServer } from "node:http"
import { once } from "node:events"
import { createTestServer } from "../../test/vite"
import { createOpenScienceClient, type RuntimeQueueSnapshot } from "@synsci/sdk/v2/client"

const server = await createTestServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await server.ssrLoadModule("/src/components/prompt-queue.tsx")) as typeof import("./prompt-queue")
const options = (await server.ssrLoadModule(
  "/src/components/prompt-send-options.tsx",
)) as typeof import("./prompt-send-options")
const solidjs = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  document.body.replaceChildren()
})
afterAll(() => server.close())
const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10)
  expect(predicate()).toBe(true)
}

test("send menu performs the selected action instead of only changing a mode", async () => {
  const deliveries: string[] = []
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () => options.PromptSendOptions({ disabled: false, locale: "en", send: (mode) => deliveries.push(mode) }),
      host,
    ),
  )
  const trigger = host.querySelector<HTMLButtonElement>("button")!
  for (const [label, delivery] of [
    ["Guide current task", "guide"],
    ["Add to queue", "queue"],
  ]) {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))
    await wait(() => document.querySelector('[role="menu"]') !== null)
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) =>
      item.textContent?.includes(label!),
    )!
    item.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", button: 0, bubbles: true }))
    await wait(() => deliveries.includes(delivery!))
    await wait(() => trigger.getAttribute("aria-expanded") === "false")
  }
  expect(deliveries).toEqual(["guide", "queue"])
})

test.each(["local", "remote"])("%s drafts do not read a queue until a real session exists", async (mode) => {
  const requests: string[] = []
  let failing = false
  const http = createServer((request, response) => {
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers).end()
      return
    }
    requests.push(request.url!)
    const capability = request.url?.includes("capabilities")
    const sessionID = new URL(request.url!, "http://test").searchParams.get("sessionID")
    response.writeHead(capability ? 200 : sessionID === "new" ? 400 : failing ? 503 : 200, headers)
    response.end(
      JSON.stringify(
        capability
          ? { promptQueue: true }
          : failing
            ? { message: "Queue temporarily unavailable" }
            : { sessionID, revision: 0, paused: false, items: [] },
      ),
    )
  })
  http.listen(0, "127.0.0.1")
  await once(http, "listening")
  cleanups.push(() => {
    http.close()
    http.closeAllConnections()
  })
  const address = http.address() as { port: number }
  const baseUrl = `http://127.0.0.1:${address.port}${mode === "remote" ? "/remote-workspaces/bio/api" : ""}`
  const [sessionID, setSessionID] = solidjs.createSignal<string | undefined>("new")
  const [refresh, setRefresh] = solidjs.createSignal(0)
  let available = false
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        subject.PromptQueue({
          client: createOpenScienceClient({ baseUrl }),
          get sessionID() {
            return sessionID()
          },
          get refresh() {
            return refresh()
          },
          working: false,
          locale: "zh",
          onAvailable(value) {
            available = value
          },
        }),
      host,
    ),
  )
  await Bun.sleep(50)
  setSessionID(undefined)
  setRefresh(1)
  await Bun.sleep(50)
  expect(requests).toEqual([])
  expect(host.querySelector("section")).toBeNull()
  expect(available).toBe(false)

  setSessionID("ses_created")
  await wait(() => requests.some((url) => url.includes("/runtime/queue?sessionID=ses_created")))
  expect(available).toBe(true)
  failing = true
  setRefresh(2)
  await wait(
    () => host.querySelector('[role="alert"]')?.textContent?.includes("Queue temporarily unavailable") === true,
  )

  setSessionID("new")
  await wait(() => !available && host.querySelector("section") === null)
  const count = requests.length
  setRefresh(3)
  await Bun.sleep(50)
  expect(requests.length).toBe(count)
  expect(requests.some((url) => url.includes("sessionID=new"))).toBe(false)
})

test("a late capability response cannot enable the queue after navigating to a draft", async () => {
  const requests: string[] = []
  let release: (() => void) | undefined
  const http = createServer((request, response) => {
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers).end()
      return
    }
    requests.push(request.url!)
    release = () => response.writeHead(200, headers).end(JSON.stringify({ promptQueue: true }))
  })
  http.listen(0, "127.0.0.1")
  await once(http, "listening")
  cleanups.push(() => {
    http.close()
    http.closeAllConnections()
  })
  const address = http.address() as { port: number }
  // 模拟已完成传输、无法及时取消的响应，验证组件自身的会话生命周期保护。
  const client = createOpenScienceClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    fetch: Object.assign(
      (request: RequestInfo | URL) => fetch(new Request(request, { signal: new AbortController().signal })),
      { preconnect: fetch.preconnect },
    ),
  })
  const [sessionID, setSessionID] = solidjs.createSignal("ses_previous")
  let available = false
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        subject.PromptQueue({
          client,
          get sessionID() {
            return sessionID()
          },
          refresh: 0,
          working: false,
          locale: "en",
          onAvailable(value) {
            available = value
          },
        }),
      host,
    ),
  )
  await wait(() => !!release)
  setSessionID("new")
  release!()
  await Bun.sleep(80)
  expect(available).toBe(false)
  expect(requests).toEqual(["/runtime/capabilities"])
  expect(host.querySelector("section")).toBeNull()
})

test("a deleted session stays retired when prompt refresh or working state changes", async () => {
  let requests = 0
  const http = createServer((request, response) => {
    const cors = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors)
      response.end()
      return
    }
    const capability = request.url?.includes("capabilities")
    if (!capability) requests++
    response.writeHead(capability ? 200 : 404, cors)
    response.end(JSON.stringify(capability ? { promptQueue: true } : { message: "Session deleted" }))
  })
  http.listen(0, "127.0.0.1")
  await once(http, "listening")
  cleanups.push(() => http.close())
  const address = http.address() as { port: number }
  const client = createOpenScienceClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  const [refresh, setRefresh] = solidjs.createSignal(0)
  const [working, setWorking] = solidjs.createSignal(true)
  const host = document.createElement("div")
  document.body.append(host)
  let available = false
  cleanups.push(
    web.render(
      () =>
        subject.PromptQueue({
          client,
          sessionID: "ses_deleted",
          locale: "en",
          get refresh() {
            return refresh()
          },
          get working() {
            return working()
          },
          onAvailable: (value) => {
            available = value
          },
        }),
      host,
    ),
  )
  await wait(() => requests === 1 && !available)
  setRefresh(1)
  setWorking(false)
  await Bun.sleep(50)
  expect(requests).toBe(1)
  expect(host.querySelector('[role="alert"]')).toBeNull()
})

test("queued messages can be edited and removed with accessible controls and errors retain the editor", async () => {
  let snapshot: RuntimeQueueSnapshot = {
    sessionID: "ses_test",
    revision: 1,
    paused: true,
    items: [
      {
        id: "first",
        createdAt: 1,
        input: { sessionID: "ses_test", message: "Inspect data", effort: "normal", variant: "high" },
      },
    ],
  }
  let reject = true
  const http = createServer(async (request, response) => {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,PATCH,OPTIONS",
    }
    const send = (body: unknown, status = 200) => {
      response.writeHead(status, { ...headers, "Content-Type": "application/json" })
      response.end(status === 204 ? undefined : JSON.stringify(body))
    }
    if (request.method === "OPTIONS") return send(undefined, 204)
    if (request.url?.includes("capabilities")) return send({ promptQueue: true })
    if (request.method === "PATCH") {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { change: { type: string; text: string } }
      if (reject) return send({ message: "Queue changed in another window" }, 409)
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        items:
          body.change.type === "remove"
            ? []
            : snapshot.items.map((item) => ({ ...item, input: { ...item.input, message: body.change.text } })),
      }
    }
    return send(snapshot)
  })
  http.listen(0, "127.0.0.1")
  await once(http, "listening")
  const address = http.address()
  if (!address || typeof address === "string") throw new Error("Fixture did not bind")
  await using api = {
    origin: `http://127.0.0.1:${address.port}`,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => {
        http.close(() => resolve())
        http.closeAllConnections()
      })
    },
  }
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        subject.PromptQueue({
          client: createOpenScienceClient({ baseUrl: api.origin }),
          sessionID: "ses_test",
          locale: "en",
          refresh: 0,
          working: true,
          onAvailable() {},
        }),
      host,
    ),
  )
  await wait(() => host.textContent?.includes("Inspect data") === true)
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label)!
  const more = host.querySelector<HTMLButtonElement>('[aria-label="More queue actions"]')!
  more.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))
  await wait(() => document.querySelector('[role="menu"]') !== null)
  await wait(() => document.activeElement?.getAttribute("role") === "menuitem")
  const menuItem = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent?.includes(label))!
  expect(menuItem("Move up").getAttribute("aria-disabled")).toBe("true")
  menuItem("Edit message").dispatchEvent(
    new PointerEvent("pointerup", { pointerType: "mouse", button: 0, bubbles: true }),
  )
  await wait(() => host.querySelector("textarea") !== null)
  const editor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit queued message"]')!
  editor.focus()
  editor.value = "Use corrected data"
  editor.dispatchEvent(new Event("input", { bubbles: true }))
  // 后台轮询不能重建编辑器，否则用户正在输入时会丢失焦点和选区。
  editor.setSelectionRange(4, 9)
  await Bun.sleep(2200)
  expect(host.querySelector("textarea") === editor).toBe(true)
  expect(document.activeElement === editor).toBe(true)
  expect(editor.selectionStart).toBe(4)
  expect(editor.selectionEnd).toBe(9)
  button("Save").click()
  await wait(() => host.querySelector('[role="alert"]') !== null)
  expect(host.querySelector("textarea")?.value).toBe("Use corrected data")
  reject = false
  button("Save").click()
  await wait(() => host.querySelector("textarea") === null)
  expect(host.textContent).toContain("Use corrected data")
  host.querySelector<HTMLButtonElement>('[aria-label="Remove queued message"]')!.click()
  await wait(() => host.querySelector("section") === null)
})

type QueueChange = NonNullable<
  Parameters<ReturnType<typeof createOpenScienceClient>["runtime"]["updateQueue"]>[0]
>["change"]
async function queueFixture(
  input: {
    snapshot?: RuntimeQueueSnapshot
    capabilityFailures?: number
    capabilityStatus?: number
    fetch?: typeof fetch
    update?: (
      change: QueueChange,
      revision: number,
    ) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>
  } = {},
) {
  let snapshot: RuntimeQueueSnapshot = input.snapshot ?? {
    sessionID: "ses_queue",
    revision: 3,
    paused: false,
    activeRunID: "run_current",
    items: [
      { id: "a", createdAt: 1, input: { sessionID: "ses_queue", message: "Analyze sample A", effort: "normal" } },
      { id: "b", createdAt: 2, input: { sessionID: "ses_queue", message: "Analyze sample B", effort: "normal" } },
      { id: "c", createdAt: 3, input: { sessionID: "ses_queue", message: "Analyze sample C", effort: "normal" } },
    ],
  }
  const changes: Array<{ change: QueueChange; revision: number; sessionID: string }> = []
  let capabilities = 0
  let reads = 0
  let available = false
  let guided = 0
  const http = createServer(async (request, response) => {
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,PATCH,OPTIONS",
    }
    const send = (body: unknown, status = 200) =>
      response.writeHead(status, headers).end(status === 204 ? undefined : JSON.stringify(body))
    if (request.method === "OPTIONS") return void send(undefined, 204)
    if (request.url?.includes("capabilities")) {
      capabilities++
      const status = input.capabilityStatus ?? (capabilities <= (input.capabilityFailures ?? 0) ? 503 : 200)
      return void send(status === 200 ? { promptQueue: true } : { message: "Queue capabilities unavailable" }, status)
    }
    if (request.method === "PATCH") {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as (typeof changes)[number]
      changes.push(body)
      if (input.update) {
        const result = await input.update(body.change, body.revision)
        return void send(result.body, result.status)
      }
      const change = body.change
      if (change.type === "pause" || change.type === "resume") snapshot.paused = change.type === "pause"
      else if (change.type === "remove" || change.type === "guide")
        snapshot.items = snapshot.items.filter((item) => item.id !== change.id)
      else if (change.type === "edit")
        snapshot.items = snapshot.items.map((item) =>
          item.id === change.id ? { ...item, input: { ...item.input, message: change.text } } : item,
        )
      else if (change.type === "move") {
        const item = snapshot.items.find((item) => item.id === change.id)!
        snapshot.items = snapshot.items.filter((item) => item.id !== change.id)
        snapshot.items.splice(
          change.before === null
            ? snapshot.items.length
            : snapshot.items.findIndex((item) => item.id === change.before),
          0,
          item,
        )
      }
      snapshot.revision++
      return void send(snapshot)
    }
    reads++
    send({ ...snapshot, sessionID: new URL(request.url!, "http://test").searchParams.get("sessionID") })
  })
  http.listen(0, "127.0.0.1")
  await once(http, "listening")
  const address = http.address() as { port: number }
  const [refresh, setRefresh] = solidjs.createSignal(0)
  const [working, setWorking] = solidjs.createSignal(true)
  const [session, setSession] = solidjs.createSignal(snapshot.sessionID)
  const host = document.createElement("div")
  document.body.append(host)
  const client = createOpenScienceClient({ baseUrl: `http://127.0.0.1:${address.port}`, fetch: input.fetch })
  const dispose = web.render(
    () =>
      subject.PromptQueue({
        client,
        get sessionID() {
          return session()
        },
        get refresh() {
          return refresh()
        },
        get working() {
          return working()
        },
        locale: "en",
        onAvailable(value) {
          available = value
        },
        onGuided() {
          guided++
        },
      }),
    host,
  )
  cleanups.push(() => {
    dispose()
    http.close()
    http.closeAllConnections()
  })
  return {
    host,
    changes,
    setWorking,
    setSession,
    dispose,
    get snapshot() {
      return snapshot
    },
    set snapshot(value) {
      snapshot = value
    },
    get capabilities() {
      return capabilities
    },
    get reads() {
      return reads
    },
    get available() {
      return available
    },
    get guided() {
      return guided
    },
    refresh: () => setRefresh((value) => value + 1),
    row: (index = 0) => host.querySelectorAll<HTMLLIElement>(".prompt-queue__item")[index]!,
  }
}
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent?.includes(label))!
const openQueueMenu = async (row: HTMLElement) => {
  row
    .querySelector<HTMLButtonElement>('[aria-label="More queue actions"]')!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))
  await wait(
    () =>
      document.querySelector('[role="menu"]') !== null && document.activeElement?.getAttribute("role") === "menuitem",
  )
}
const selectQueueMenu = async (label: string) => {
  const trigger = document.querySelector('[aria-label="More queue actions"][aria-expanded="true"]')!
  menuItem(label).dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", button: 0, bubbles: true }))
  await wait(() => trigger.getAttribute("aria-expanded") === "false")
}
const queueButton = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label)!

const measureQueue = (host: HTMLElement) => {
  const list = host.querySelector<HTMLElement>(".prompt-queue__items")!
  list.getBoundingClientRect = () => new DOMRect(0, 0, 600, 132)
  host.querySelectorAll<HTMLElement>(".prompt-queue__item").forEach((row, index) => {
    row.getBoundingClientRect = () => {
      const offset = Number(row.style.transform.match(/translateY\((-?[\d.]+)px\)/)?.[1] ?? 0)
      return new DOMRect(0, index * 44 + offset, 600, 44)
    }
  })
}
const point = (handle: HTMLElement, type: string, x: number, y: number, pointerType = "mouse") =>
  handle.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 1,
      pointerType,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }),
  )

test.each(["mouse", "touch"])(
  "%s dragging changes durable queue order; stationary clicks and outside drops do not",
  async (pointerType) => {
    const fixture = await queueFixture()
    await wait(() => fixture.host.querySelectorAll(".prompt-queue__item").length === 3)
    measureQueue(fixture.host)
    const handle = fixture.row().querySelector<HTMLElement>(".prompt-queue__drag")!
    point(handle, "pointerdown", 16, 22, pointerType)
    point(handle, "pointerup", 16, 22, pointerType)
    expect(fixture.changes).toHaveLength(0)
    point(handle, "pointerdown", 16, 22, pointerType)
    point(handle, "pointermove", 700, 120, pointerType)
    point(handle, "pointerup", 700, 120, pointerType)
    expect(fixture.changes).toHaveLength(0)
    point(handle, "pointerdown", 16, 22, pointerType)
    point(handle, "pointermove", 16, 120, pointerType)
    expect(fixture.host.querySelector("[data-dragging]")).not.toBeNull()
    expect(fixture.row(2).hasAttribute("data-drop-after")).toBe(true)
    point(handle, "pointerup", 16, 120, pointerType)
    await wait(() => fixture.row(2).dataset.queueId === "a")
    expect(fixture.changes).toEqual([
      { change: { type: "move", id: "a", before: null }, revision: 3, sessionID: "ses_queue" },
    ])
    expect(fixture.host.querySelector("[data-dragging]")).toBeNull()
    expect(fixture.host.textContent).toContain("Message moved to position 3.")
  },
)

test("Escape and a changed queue revision cancel dragging without submitting a stale order", async () => {
  const fixture = await queueFixture()
  await wait(() => fixture.host.querySelectorAll(".prompt-queue__item").length === 3)
  measureQueue(fixture.host)
  const handle = fixture.row().querySelector<HTMLElement>(".prompt-queue__drag")!
  point(handle, "pointerdown", 16, 22)
  point(handle, "pointermove", 16, 120)
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  handle.dispatchEvent(escape)
  expect(escape.defaultPrevented).toBe(true)
  point(handle, "pointerup", 16, 120)
  expect(fixture.changes).toHaveLength(0)
  point(handle, "pointerdown", 16, 22)
  point(handle, "pointermove", 16, 120)
  fixture.snapshot = { ...fixture.snapshot, revision: 4 }
  fixture.refresh()
  await wait(() => fixture.host.querySelector("[data-dragging]") === null)
  point(handle, "pointerup", 16, 120)
  expect(fixture.changes).toHaveLength(0)
})

test("queue handles reorder with arrow keys and remain focusable after moving", async () => {
  const fixture = await queueFixture()
  await wait(() => fixture.host.querySelectorAll(".prompt-queue__item").length === 3)
  const handle = fixture.row(1).querySelector<HTMLElement>(".prompt-queue__drag")!
  handle.focus()
  handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }))
  await wait(() => fixture.row().dataset.queueId === "b")
  expect(fixture.changes[0]?.change).toEqual({ type: "move", id: "b", before: "a" })
  expect(document.activeElement).toBe(handle)
  handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))
  await wait(() => fixture.row(1).dataset.queueId === "b")
  expect(fixture.changes[1]?.change).toEqual({ type: "move", id: "b", before: "c" })
})

test("queue guide atomically promotes the selected item using the current snapshot run", async () => {
  const fixture = await queueFixture()
  await wait(() => fixture.host.querySelectorAll(".prompt-queue__item").length === 3)
  const guide = fixture.row(1).querySelector<HTMLButtonElement>('[aria-label="Steer current task"]')!
  expect(guide.disabled).toBe(false)
  guide.click()
  await wait(() => fixture.guided === 1 && fixture.host.querySelectorAll(".prompt-queue__item").length === 2)
  expect(fixture.changes).toEqual([
    { sessionID: "ses_queue", revision: 3, change: { type: "guide", id: "b", runID: "run_current" } },
  ])
  expect(fixture.host.textContent).not.toContain("Analyze sample B")
  expect(fixture.host.textContent).toContain("Analyze sample A")
})

test("unsupported, idle and dispatching tasks cannot guide or modify an in-flight message", async () => {
  const fixture = await queueFixture()
  await wait(() => fixture.host.querySelectorAll(".prompt-queue__item").length === 3)
  const guide = () => fixture.row().querySelector<HTMLButtonElement>('[aria-label="Steer current task"]')!
  fixture.setWorking(false)
  expect(guide().disabled).toBe(true)
  fixture.setWorking(true)
  fixture.snapshot = { ...fixture.snapshot, activeRunID: undefined }
  fixture.refresh()
  await wait(() => guide().disabled)
  expect(guide().title).toContain("supported task")
  fixture.snapshot = { ...fixture.snapshot, activeRunID: "run_current", dispatching: "a", revision: 4 }
  fixture.refresh()
  await wait(() => fixture.row().textContent?.includes("Sending…") === true)
  expect(guide().disabled).toBe(true)
  expect(fixture.row().querySelector<HTMLButtonElement>('[aria-label="Remove queued message"]')!.disabled).toBe(true)
  expect(fixture.row().querySelector<HTMLButtonElement>('[aria-label="More queue actions"]')!.disabled).toBe(true)
  guide().click()
  expect(fixture.changes).toEqual([])
})

test("more menu reorders the selected item and preserves pause and resume", async () => {
  const fixture = await queueFixture()
  await wait(() => fixture.host.querySelectorAll(".prompt-queue__item").length === 3)
  await openQueueMenu(fixture.row())
  expect(menuItem("Move up").getAttribute("aria-disabled")).toBe("true")
  await selectQueueMenu("Move down")
  await wait(() => fixture.row().textContent?.includes("Analyze sample B") === true)
  expect(fixture.changes[0]!.change).toEqual({ type: "move", id: "a", before: "c" })
  await openQueueMenu(fixture.row(1))
  await selectQueueMenu("Move up")
  await wait(() => fixture.row().textContent?.includes("Analyze sample A") === true)
  expect(fixture.changes[1]!.change).toEqual({ type: "move", id: "a", before: "b" })
  await openQueueMenu(fixture.row())
  await selectQueueMenu("Pause queue")
  await wait(() => fixture.host.textContent?.includes("Queue paused") === true)
  queueButton(fixture.host, "Resume queue").click()
  await wait(() => fixture.changes.length === 4 && fixture.host.textContent?.includes("Queue paused") === false)
  expect(fixture.changes.slice(2).map((item) => item.change)).toEqual([{ type: "pause" }, { type: "resume" }])
})

test("a failed guide retains the queued message and manual refresh clears the resolved error", async () => {
  const fixture = await queueFixture({
    update: () => ({ status: 409, body: { message: "The current task has finished" } }),
  })
  await wait(() => fixture.host.querySelectorAll(".prompt-queue__item").length === 3)
  fixture.row().querySelector<HTMLButtonElement>('[aria-label="Steer current task"]')!.click()
  await wait(() => fixture.host.querySelector('[role="alert"]') !== null && fixture.reads > 1)
  expect(fixture.host.textContent).toContain("Analyze sample A")
  expect(fixture.guided).toBe(0)
  expect(fixture.host.textContent).toContain("The current task has finished")
  const reads = fixture.reads
  queueButton(fixture.host, "Refresh queue").click()
  await wait(() => fixture.host.querySelector('[role="alert"]') === null && fixture.reads > reads)
  expect(fixture.host.querySelectorAll(".prompt-queue__item")).toHaveLength(3)
})

test("initial capability failures recover automatically but an old server is not repeatedly polled", async () => {
  const recovering = await queueFixture({ capabilityFailures: 1 })
  await wait(() => recovering.host.querySelector('[role="alert"]') !== null)
  await wait(() => recovering.available && recovering.host.querySelectorAll(".prompt-queue__item").length === 3)
  expect(recovering.capabilities).toBe(2)
  expect(recovering.host.querySelector('[role="alert"]')).toBeNull()
  const legacy = await queueFixture({ capabilityStatus: 404 })
  await wait(() => legacy.capabilities === 1)
  await Bun.sleep(1100)
  legacy.refresh()
  await Bun.sleep(50)
  expect(legacy.capabilities).toBe(1)
  expect(legacy.reads).toBe(0)
  expect(legacy.available).toBe(false)
  expect(legacy.host.querySelector("section")).toBeNull()
})

test("edits preserve the draft across a conflicting remote update and require an explicit choice", async () => {
  const fixture = await queueFixture()
  await wait(() => fixture.host.querySelectorAll(".prompt-queue__item").length === 3)
  fixture.row().querySelector<HTMLButtonElement>('[aria-label="Edit message"]')!.click()
  await wait(() => fixture.host.querySelector("textarea") !== null)
  expect(document.activeElement).toBe(fixture.host.querySelector("textarea"))
  const editor = fixture.host.querySelector<HTMLTextAreaElement>("textarea")!
  editor.value = "My revised analysis"
  editor.dispatchEvent(new Event("input", { bubbles: true }))
  fixture.snapshot = {
    ...fixture.snapshot,
    revision: 4,
    items: fixture.snapshot.items.map((item) =>
      item.id === "a" ? { ...item, input: { ...item.input, message: "Analysis from another window" } } : item,
    ),
  }
  fixture.refresh()
  await wait(() => fixture.host.textContent?.includes("This message changed in another window") === true)
  expect(fixture.host.querySelector("textarea")).toBe(editor)
  expect(editor.value).toBe("My revised analysis")
  expect(queueButton(fixture.host, "Save").disabled).toBe(true)
  queueButton(fixture.host, "Keep my changes").click()
  expect(editor.value).toBe("My revised analysis")
  expect(queueButton(fixture.host, "Save").disabled).toBe(false)
  queueButton(fixture.host, "Save").click()
  await wait(() => fixture.host.querySelector("textarea") === null)
  expect(fixture.changes[0]).toEqual({
    sessionID: "ses_queue",
    revision: 4,
    change: { type: "edit", id: "a", text: "My revised analysis" },
  })
})

test("late mutation responses cannot alter another session or emit its guide notification", async () => {
  let release: (() => void) | undefined
  const fixture = await queueFixture({
    update: () =>
      new Promise((resolve) => {
        release = () => resolve({ body: { sessionID: "ses_queue", revision: 4, paused: false, items: [] } })
      }),
  })
  await wait(() => fixture.host.querySelectorAll(".prompt-queue__item").length === 3)
  fixture.row().querySelector<HTMLButtonElement>('[aria-label="Steer current task"]')!.click()
  await wait(() => !!release)
  fixture.setSession("ses_other")
  await wait(() => fixture.reads > 1 && fixture.host.querySelectorAll(".prompt-queue__item").length === 3)
  release!()
  await Bun.sleep(80)
  expect(fixture.guided).toBe(0)
  expect(fixture.host.querySelectorAll(".prompt-queue__item")).toHaveLength(3)
  expect(fixture.host.querySelector('[role="alert"]')).toBeNull()
})

test("session-busy pause gives a resumable command hint", async () => {
  const fixture = await queueFixture({
    snapshot: {
      sessionID: "ses_busy",
      revision: 1,
      paused: true,
      reason: "session_busy",
      items: [{ id: "a", createdAt: 1, input: { sessionID: "ses_busy", message: "Next analysis", effort: "normal" } }],
    },
  })
  await wait(() => fixture.host.textContent?.includes("After the current command finishes") === true)
  expect(queueButton(fixture.host, "Resume queue")).toBeDefined()
  expect(fixture.row().querySelector<HTMLButtonElement>('[aria-label="Steer current task"]')!.disabled).toBe(true)
})

test("a stalled queue read times out and polling recovers without an external refresh", async () => {
  const timeout = globalThis.setTimeout
  globalThis.setTimeout = ((handler: TimerHandler, milliseconds?: number, ...args: unknown[]) =>
    timeout(handler, milliseconds === 30_000 ? 100 : milliseconds, ...args)) as typeof setTimeout
  cleanups.push(() => {
    globalThis.setTimeout = timeout
  })
  let pending = true
  const fixture = await queueFixture({
    fetch: Object.assign(
      (request: RequestInfo | URL) => {
        if (
          pending &&
          new URL(request instanceof Request ? request.url : String(request)).pathname.endsWith("/runtime/queue")
        ) {
          pending = false
          // 桌面传输可能既不响应也忽略取消；必须依靠组件截止时间退出等待。
          return new Promise<Response>(() => {})
        }
        return fetch(request)
      },
      { preconnect: fetch.preconnect },
    ),
  })
  await wait(() => fixture.host.querySelector('[role="alert"]')?.textContent?.includes("too long") === true)
  globalThis.setTimeout = timeout
  await wait(() => fixture.host.querySelectorAll(".prompt-queue__item").length === 3)
  expect(fixture.host.querySelector('[role="alert"]')).toBeNull()
  expect(fixture.capabilities).toBe(1)
  expect(fixture.reads).toBe(1)
})

test("editing the prompt shows retained context and rebases unrelated queue changes", async () => {
  const fixture = await queueFixture({
    snapshot: {
      sessionID: "ses_queue",
      revision: 3,
      paused: true,
      items: [
        {
          id: "a",
          createdAt: 1,
          input: {
            sessionID: "ses_queue",
            effort: "normal",
            model: { providerID: "provider", modelID: "research-model" },
            parts: [
              { type: "text", text: "Main instruction" },
              { type: "text", text: "File comment context" },
              { type: "file", mime: "text/csv", url: "file:///sample.csv", filename: "sample.csv" },
            ],
          },
        },
      ],
    },
  })
  await wait(() => fixture.host.textContent?.includes("Main instruction") === true)
  expect(fixture.host.textContent).toContain("Includes additional context")
  expect(fixture.host.textContent).toContain("Includes attachments")
  expect(fixture.row().querySelector(".prompt-queue__text")?.getAttribute("title")).toContain("research-model")
  await openQueueMenu(fixture.row())
  await selectQueueMenu("Edit message")
  expect(fixture.host.textContent).toContain("research-model")
  const editor = fixture.host.querySelector<HTMLTextAreaElement>("textarea")!
  expect(editor.value).toBe("Main instruction")
  editor.value = "Revised instruction"
  editor.dispatchEvent(new Event("input", { bubbles: true }))
  fixture.snapshot = {
    ...fixture.snapshot,
    revision: 4,
    items: [
      ...fixture.snapshot.items,
      { id: "b", createdAt: 2, input: { sessionID: "ses_queue", effort: "normal", message: "Another queued prompt" } },
    ],
  }
  fixture.refresh()
  await wait(() => fixture.host.querySelectorAll(".prompt-queue__item").length === 2)
  expect(editor.value).toBe("Revised instruction")
  expect(fixture.host.textContent).not.toContain("This message changed in another window")
  queueButton(fixture.host, "Save").click()
  await wait(() => fixture.changes.length === 1 && fixture.host.querySelector("textarea") === null)
  expect(fixture.changes[0]).toEqual({
    sessionID: "ses_queue",
    revision: 4,
    change: { type: "edit", id: "a", text: "Revised instruction" },
  })
})
