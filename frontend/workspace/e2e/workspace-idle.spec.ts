import { expect, test } from "./fixtures"
import { promptSelector } from "./utils"

test("built workspace retains its document and draft after background suspension and network recovery", async ({
  page,
  context,
  gotoSession,
}) => {
  test.skip(process.env.OPENSCIENCE_E2E_PACKAGED !== "1", "Requires a built workspace without the Vite HMR client")
  const sockets: string[] = []
  page.on("websocket", (socket) => sockets.push(socket.url()))
  await gotoSession()
  const input = page.locator(promptSelector)
  const draft = "Keep this unsent draft while I read another tab."
  await input.fill(draft)
  const editor = await input.elementHandle()
  const origin = await page.evaluate(() => performance.timeOrigin)
  const url = page.url()
  const background = await context.newPage()
  const cdp = await context.newCDPSession(page)
  try {
    await background.goto("about:blank")
    await background.bringToFront()
    await context.setOffline(true)
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" })
    // 真实冻结页面后恢复，不通过重载代替唤醒；既有 SSE 可能保持连接，恢复以健康探测为准。
    await page.waitForTimeout(1500)
    await cdp.send("Page.setWebLifecycleState", { state: "active" })
    await context.setOffline(false)
    const health = page.waitForResponse(
      (response) => new URL(response.url()).pathname.endsWith("/global/health") && response.ok(),
      { timeout: 15000 },
    )
    await page.bringToFront()
    await health
    await expect(input).toHaveText(draft)
    expect(await editor!.evaluate((element) => element.isConnected)).toBe(true)
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin)
    expect(page.url()).toBe(url)
    const resources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name))
    expect(resources.some((name) => name.includes("/@vite/client"))).toBe(false)
    expect(sockets).toEqual([])
  } finally {
    if (!page.isClosed()) {
      await cdp.send("Page.setWebLifecycleState", { state: "active" })
      await context.setOffline(false)
      await cdp.detach()
    }
    if (!background.isClosed()) await background.close()
  }
})
