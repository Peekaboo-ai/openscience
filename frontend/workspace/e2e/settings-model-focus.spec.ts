import { test, expect } from "@playwright/test"
import { serverUrl } from "./utils"

for (const colorScheme of ["light", "dark"] as const) {
  test(`model selection keeps the settings viewport in place (${colorScheme})`, async ({ page, request }, testInfo) => {
    await page.emulateMedia({ colorScheme })
    await page.addInitScript((scheme) => localStorage.setItem("openscience-color-scheme", scheme), colorScheme)
    await page.setViewportSize({ width: 1440, height: 900 })
    const ids = Array.from({ length: 40 }, (_, index) => `review-model-${String(index).padStart(2, "0")}`)
    await page.route("**/settings/model-connections", (route) =>
      route.fulfill({
        json: {
          connections: [
            {
              id: "review",
              name: "Review provider",
              baseURL: "https://example.test/v1",
              protocol: "openai-responses",
              thinking: "auto",
              models: ids,
              hasKey: true,
              context: 128000,
              output: 4096,
              limits: Object.fromEntries(
                ids.map((id) => [id, { context: 128000, output: 4096, mode: "auto", source: "catalog" }]),
              ),
            },
          ],
        },
      }),
    )
    const response = await request.get(`${serverUrl}/workspace/catalog`)
    const catalog = await response.json()
    const projectID = catalog.tasksProjectID ?? catalog.projects[0]?.id
    expect(projectID).toBeTruthy()
    await page.goto(`/${projectID}/session/new`)
    await page
      .locator(".workspace-sidebar-footer")
      .getByRole("button", { name: /^Settings/ })
      .click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("button", { name: "Models", exact: true }).click()
    await dialog
      .locator(".models-connected-providers .settings-row")
      .filter({ hasText: "Review provider" })
      .getByRole("button", { name: "Edit", exact: true })
      .click()
    for (const expanded of [false, true]) {
      if (expanded) await dialog.getByRole("button", { name: "Expand", exact: true }).click()
      const checkbox = dialog.getByRole("checkbox", { name: ids[38], exact: true })
      const control = checkbox.locator("..").locator('[data-slot="checkbox-checkbox-control"]')
      await control.scrollIntoViewIfNeeded()
      const viewport = dialog.locator(".settings-main__viewport")
      const panel = dialog.locator(".settings-models-panel")
      const bounds = await panel.boundingBox()
      const before = await checkbox.isChecked()
      await control.click()
      await expect(checkbox).toBeChecked({ checked: !before })
      await expect.poll(() => viewport.evaluate((e) => e.scrollTop)).toBe(0)
      await expect.poll(async () => (await panel.boundingBox())?.y).toBe(bounds?.y)
      await expect(control).toBeInViewport()
      await checkbox.press("Space")
      await expect(checkbox).toBeChecked({ checked: before })
      await expect(control).toBeInViewport()
      await expect.poll(() => viewport.evaluate((e) => e.scrollTop)).toBe(0)
    }
    await page.screenshot({ path: testInfo.outputPath(`settings-models-${colorScheme}.png`) })
    await page.setViewportSize({ width: 720, height: 800 })
    const first = dialog.getByRole("checkbox", { name: ids[0], exact: true })
    await first.locator("..").locator('[data-slot="checkbox-checkbox-label"]').click()
    await expect(first).not.toBeChecked()
    await expect.poll(() => dialog.locator(".settings-main__viewport").evaluate((e) => e.scrollTop)).toBe(0)
    await expect(dialog.getByRole("button", { name: "Save changes", exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`settings-models-${colorScheme}-narrow.png`) })
  })
}
