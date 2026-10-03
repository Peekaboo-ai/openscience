import { test, expect } from "@playwright/test"
import { modelTriggerSelector, serverUrl } from "./utils"

import { provider, providerID } from "./composer-fixture"

for (const colorScheme of ["light", "dark"] as const) {
  test(`model change notices follow the user's choice and saved turns (${colorScheme})`, async ({
    page,
    request,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme })
    await page.addInitScript((scheme) => localStorage.setItem("openscience-color-scheme", scheme), colorScheme)
    await page.setViewportSize({ width: 1440, height: 900 })
    const catalog = await request.get(`${serverUrl}/workspace/catalog`).then((r) => r.json())
    const projectID = catalog.tasksProjectID ?? catalog.projects[0]?.id
    const headers = { "x-openscience-project": projectID }
    const session = await request
      .post(`${serverUrl}/session`, { headers, data: { title: "Model switch UI verification" } })
      .then((r) => r.json())
    expect(session.id).toBeTruthy()
    const base = `/${projectID}/session/${session.id}`
    const turns: ReturnType<typeof turn>[] = []
    function turn(index: number, modelID: string, userID = `msg_00000000000${index}0`) {
      const now = Date.now() + index
      const assistantID = index === 1 ? "msg_0000000000011" : "msg_ffffffffffff1"
      return [
        {
          info: {
            id: userID,
            sessionID: session.id,
            role: "user",
            time: { created: now },
            agent: "research",
            model: { providerID, modelID },
          },
          parts: [
            {
              id: `prt_switch_${index}0`,
              sessionID: session.id,
              messageID: userID,
              type: "text",
              text: "Review the completed research results.",
            },
          ],
        },
        {
          info: {
            id: assistantID,
            sessionID: session.id,
            role: "assistant",
            parentID: userID,
            modelID,
            providerID,
            agent: "research",
            mode: "research",
            time: { created: now + 1, completed: now + 2 },
            cost: 0,
            tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
            path: { cwd: session.directory, root: session.directory },
            finish: "stop",
          },
          parts: [
            {
              id: `prt_switch_${index}1`,
              sessionID: session.id,
              messageID: assistantID,
              type: "text",
              text: "The report is ready. You can continue reviewing it in this conversation.",
            },
          ],
        },
      ]
    }
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("**/runtime/capabilities*", (route) =>
      route.fulfill({ json: { protocolVersion: "1.0", idempotentPrompts: true, richInputs: true, promptQueue: true } }),
    )
    await page.route("**/provider", (route) =>
      route.fulfill({ json: { all: [provider], connected: [providerID], default: { [providerID]: "gpt-6.1-sol" } } }),
    )
    await page.route("**/config", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { model: `${providerID}/gpt-6.1-sol`, billing: { llm: "byok" } } })
        : route.continue(),
    )
    await page.route(
      (url) => url.origin === serverUrl && url.pathname === "/session",
      (route) => (route.request().method() === "GET" ? route.fulfill({ json: [session] }) : route.abort()),
    )
    await page.route(
      (url) => url.origin === serverUrl && url.pathname === `/session/${session.id}`,
      (route) => (route.request().method() === "GET" ? route.fulfill({ json: session }) : route.abort()),
    )
    await page.route(new RegExp(`/session/${session.id}/message(?:\\?|$)`), (route) =>
      route.request().method() === "GET" ? route.fulfill({ json: turns.flat() }) : route.abort(),
    )
    await page.route("**/runtime/prompt*", async (route) => {
      const body = route.request().postDataJSON()
      expect(body.sessionID).toBe(session.id)
      turns.push(turn(2, body.model.modelID, body.messageID))
      await route.fulfill({ json: { sessionID: session.id, messageID: body.messageID, requestID: body.requestID } })
    })
    const notices = page.locator('[data-component="model-switch-notice"]')
    const pending = notices.filter({ has: page.locator('[role="status"]') })
    const choose = async (id: string) => {
      await page.locator(modelTriggerSelector).click()
      const choice = page.locator(`[data-model-choice$="/${id}"]:visible`)
      if ((await choice.count()) === 0) await page.locator('[data-model-menu-row="model"]').click()
      await page.locator(`[data-model-choice$="/${id}"]:visible`).first().click()
    }
    try {
      await page.goto(base)
      await choose("gpt-6-astra")
      await expect(notices).toHaveCount(0)
      turns.push(turn(1, "gpt-6.1-sol"))
      await page.reload()
      await expect(page.locator('[data-message-id="msg_0000000000010"]')).toBeVisible()
      await expect(notices).toHaveCount(0)
      await choose("gpt-6.1-sol")
      await choose("gpt-6-astra")
      await expect(pending).toHaveCount(1)
      await expect(pending).toContainText("GPT-6.1 Sol")
      await expect(pending).toContainText("GPT-6 Astra")
      await choose("claude-opus-5")
      await expect(notices).toHaveCount(1)
      await expect(pending).toContainText("Claude Opus 5")
      await choose("gpt-6.1-sol")
      await expect(notices).toHaveCount(0)
      await choose("gpt-6-astra")
      await page.reload()
      await expect(pending).toHaveCount(1)
      await expect(page.locator(`[data-session-tab="${session.id}"]`)).toContainText(session.title)
      const help = pending.getByRole("button", { name: "About this model change" })
      await help.focus()
      await expect(page.locator('[role="tooltip"][data-expanded]')).toContainText("next message")
      await page.keyboard.press("Escape")
      await page.locator('[data-component="prompt-input"][contenteditable="true"]').click()
      await page.keyboard.type("Continue with this model.")
      const send = page.locator('[data-composer-action="send"]')
      await expect(send).toBeEnabled()
      await send.click()
      await expect.poll(() => turns.length).toBe(2)
      await page.reload()
      await expect(notices).toHaveCount(1)
      await expect(pending).toHaveCount(0)
      await expect(
        page.locator(`[data-message-id="${turns[1][0].info.id}"] [data-component="model-switch-notice"]`),
      ).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`model-switch-${colorScheme}.png`) })
      await page.setViewportSize({ width: 720, height: 800 })
      await notices.scrollIntoViewIfNeeded()
      expect(await notices.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await expect(notices).toBeInViewport()
      expect(errors).toEqual([])
    } catch (error) {
      await page.screenshot({ path: testInfo.outputPath("before-cleanup.png") })
      throw error
    } finally {
      await request.delete(`${serverUrl}/session/${session.id}`, { headers })
    }
  })
}
