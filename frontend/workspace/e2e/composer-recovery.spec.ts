import { test, expect, type Page } from "@playwright/test"
import { provider, providerID } from "./composer-fixture"
import { serverUrl } from "./utils"

const input = '[data-component="prompt-input"][contenteditable="true"]'
const model = { providerID, modelID: "gpt-6.1-sol" }

async function send(page: Page, message: string) {
  await page.locator(input).click()
  await page.keyboard.type(message)
  await page.locator('[data-composer-action="send"]').click()
}

test("delayed failures and stopping pending prompts preserve drafts and release busy state", async ({
  page,
  request,
}) => {
  const catalog = await request.get(`${serverUrl}/workspace/catalog`).then((response) => response.json())
  const projectID = catalog.tasksProjectID
  const headers = { "x-openscience-project": projectID }
  const sessions = []
  for (const title of ["Audit draft recovery A", "Audit draft recovery B"]) {
    const response = await request.post(`${serverUrl}/session`, { headers, data: { title } })
    expect(response.ok()).toBe(true)
    sessions.push(await response.json())
  }
  const releases: Array<() => void> = []
  const requests: Array<{ sessionID: string; messageID: string }> = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/provider", (route) =>
    route.fulfill({
      json: {
        all: [provider],
        connected: [providerID],
        default: { [providerID]: model.modelID },
      },
    }),
  )
  await page.route("**/config", (route) =>
    route.fulfill({ json: { model: `${providerID}/${model.modelID}`, billing: { llm: "byok" } } }),
  )
  await page.route("**/runtime/capabilities*", (route) =>
    route.fulfill({
      json: {
        protocolVersion: "1.0",
        idempotentPrompts: true,
        richInputs: true,
        promptQueue: true,
      },
    }),
  )
  await page.route(
    (url) => url.origin === serverUrl && url.pathname === "/session",
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: sessions.toSorted((a, b) => a.id.localeCompare(b.id)) })
        : route.abort(),
  )
  await page.route(
    (url) => url.origin === serverUrl && /^\/session\/[^/]+\/message$/.test(url.pathname),
    (route) => (route.request().method() === "GET" ? route.fulfill({ json: [] }) : route.abort()),
  )
  await page.route("**/runtime/prompt*", async (route) => {
    requests.push(route.request().postDataJSON())
    await new Promise<void>((resolve) => releases.push(resolve))
    await route.fulfill({ status: 503, json: { message: "Audit simulated failure" } })
  })
  const visit = async (index: number) => {
    await page.locator(`[data-session-id="${sessions[index].id}"] .workspace-row-main`).click()
    await expect(page).toHaveURL(new RegExp(`/session/${sessions[index].id}$`))
  }
  try {
    await page.goto(`/${projectID}/session/${sessions[0].id}`)
    await expect(page.locator(`[data-session-tab="${sessions[0].id}"]`)).toContainText(sessions[0].title)
    await send(page, "Research original A")
    await expect.poll(() => requests.length).toBe(1)
    await visit(1)
    await page.locator(input).click()
    await page.keyboard.type("Keep draft B")
    releases[0]()
    await expect(page.getByText("Audit simulated failure", { exact: false }).first()).toBeVisible()
    await expect(page.locator(input)).toHaveText("Keep draft B")
    await visit(0)
    await expect(page.locator(input)).toHaveText("Research original A")
    await page.locator(input).fill("")
    await send(page, "First pending A")
    await expect.poll(() => requests.length).toBe(2)
    await page.locator(input).fill("Later pending A")
    await expect(page.locator('[data-composer-action="send"]')).toBeDisabled()
    await page.locator(input).press("Enter")
    expect(requests).toHaveLength(2)
    releases[1]()
    await expect(page.locator(`[data-message-id="${requests[1].messageID}"]`)).toHaveCount(0)
    await expect(page.locator(input)).toHaveText("Later pending A")
    await expect(page.locator('[data-composer-action="send"]')).toBeEnabled()
    await page.locator('[data-composer-action="send"]').click()
    await expect.poll(() => requests.length).toBe(3)
    releases[2]()
    await expect(page.locator(input)).toHaveText("Later pending A")
    await page.locator(input).fill("")
    await expect(page.locator('[data-composer-action="idle"]')).toBeVisible()
    const negotiations: Array<() => void> = []
    await page.route("**/runtime/capabilities*", async (route) => {
      await new Promise<void>((resolve) => {
        negotiations.push(resolve)
        releases.push(resolve)
      })
      await route.fulfill({
        json: { protocolVersion: "1.0", idempotentPrompts: true, richInputs: true, promptQueue: true },
      })
    })
    await send(page, "Pending before stop")
    await expect.poll(() => negotiations.length).toBeGreaterThanOrEqual(1)
    await page.locator(input).fill("Latest pending before stop")
    await expect(page.locator('[data-composer-action="send"]')).toBeDisabled()
    await page.locator(input).press("Escape")
    await expect(page.locator(input)).toHaveText("Latest pending before stop")
    await page.locator(input).fill("")
    await expect(page.locator('[data-composer-action="idle"]')).toBeVisible()
    negotiations.forEach((resolve) => resolve())
    await page.waitForTimeout(250)
    expect(requests).toHaveLength(3)
    expect(errors).toEqual([])
  } finally {
    releases.forEach((release) => release())
    for (const session of sessions) await request.delete(`${serverUrl}/session/${session.id}`, { headers })
  }
})

test("a failed first prompt restores to the created conversation and sending waits for missing metadata", async ({
  page,
  request,
}) => {
  const catalog = await request.get(`${serverUrl}/workspace/catalog`).then((response) => response.json())
  const projectID = catalog.tasksProjectID
  const headers = { "x-openscience-project": projectID }
  let created: { id: string } | undefined
  let submissions = 0
  let metadata: (() => void) | undefined
  await page.route("**/provider", (route) =>
    route.fulfill({
      json: {
        all: [provider],
        connected: [providerID],
        default: { [providerID]: model.modelID },
      },
    }),
  )
  await page.route("**/config", (route) =>
    route.fulfill({ json: { model: `${providerID}/${model.modelID}`, billing: { llm: "byok" } } }),
  )
  await page.route("**/runtime/capabilities*", (route) =>
    route.fulfill({
      json: {
        protocolVersion: "1.0",
        idempotentPrompts: true,
        richInputs: true,
        promptQueue: true,
      },
    }),
  )
  await page.route(
    (url) => url.origin === serverUrl && url.pathname === "/session",
    async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: [] })
      const response = await route.fetch()
      created = await response.json()
      await route.fulfill({ response })
    },
  )
  await page.route("**/runtime/prompt*", (route) => {
    submissions++
    return route.fulfill({ status: 503, json: { message: "Audit first prompt failure" } })
  })
  try {
    await page.goto(`/${projectID}/session/new`)
    await send(page, "Start a new research task")
    await expect.poll(() => submissions).toBe(1)
    expect(created?.id).toBeTruthy()
    await expect(page).toHaveURL(new RegExp(`/session/${created!.id}$`))
    await expect(page.locator(input)).toHaveText("Start a new research task")
    await page.route(
      (url) => url.origin === serverUrl && url.pathname === `/session/${created!.id}`,
      async (route) => {
        await new Promise<void>((resolve) => {
          metadata = resolve
        })
        await route.fulfill({ json: created })
      },
    )
    await page.reload()
    await expect.poll(() => !!metadata).toBe(true)
    await expect(page.locator(input)).toHaveText("Start a new research task")
    await page.locator('[data-composer-action="send"]').click()
    await expect(page.locator('[data-component="prompt-input"]')).toHaveAttribute("aria-busy", "true")
    expect(submissions).toBe(1)
    metadata!()
    await expect.poll(() => submissions).toBe(2)
    await expect(page.locator(input)).toHaveText("Start a new research task")
  } finally {
    metadata?.()
    if (created) await request.delete(`${serverUrl}/session/${created.id}`, { headers })
  }
})
