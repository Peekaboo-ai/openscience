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
  expect(host.querySelector('[aria-label="Move up"]')?.hasAttribute("disabled")).toBe(true)
  button("Edit").click()
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
  button("Remove").click()
  await wait(() => host.querySelector("section") === null)
})
