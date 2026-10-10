import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"
import type { SpecialistServices, SpecialistSnapshot } from "./specialists-state"

const vite = await createTestServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const fixture = (await vite.ssrLoadModule(
  "/src/components/settings/specialists.fixture.tsx",
)) as typeof import("./specialists.fixture")
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const cleanups: (() => void)[] = []
afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})
const settle = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10)
  expect(check()).toBe(true)
}

test("rendered editor retains identity while choosing capabilities and saves the selected skills", async () => {
  let snapshot: SpecialistSnapshot = {
    revision: 0,
    profiles: [
      {
        name: "biology",
        displayName: "Biology",
        source: "builtin",
        updatedAt: 0,
        enabled: true,
        skillNames: null,
        connectors: null,
      },
    ],
  }
  const services: SpecialistServices = {
    label: "Fixture",
    chat: async () => {},
    request: async <T,>(path: string, init?: RequestInit) => {
      if (path.endsWith("/catalog"))
        return { skills: [{ name: "scanpy", description: "Single-cell analysis" }], connectors: [] } as T
      if (init?.method === "PUT") {
        const value = JSON.parse(String(init.body))
        snapshot = { revision: 1, profiles: [{ ...value.profile, source: "builtin", updatedAt: 1 }] }
      }
      return structuredClone(snapshot) as T
    },
  }
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(fixture.specialistView(services), host))
  await settle(() => !!host.querySelector('[aria-label="Edit Biology"]'))
  host.querySelector<HTMLButtonElement>('[aria-label="Edit Biology"]')!.click()
  await settle(() => !!host.querySelector('[aria-label="Specialist name"]'))
  const name = host.querySelector<HTMLInputElement>('[aria-label="Specialist name"]')!
  name.value = "Cell biology"
  name.dispatchEvent(new Event("input", { bubbles: true }))
  const access = host.querySelector<HTMLSelectElement>('[aria-label="Skills access"]')!
  access.value = "selected"
  access.dispatchEvent(new Event("change", { bubbles: true }))
  ;[...host.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent === "Add skills")!.click()
  await settle(() => !!host.querySelector(".specialist-picker-row input"))
  host.querySelector<HTMLInputElement>(".specialist-picker-row input")!.click()
  expect(name.value).toBe("Cell biology")
  expect(host.querySelector('[aria-label="Remove scanpy"]')).not.toBeNull()
  ;[...host.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent === "Cancel")!.click()
  expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("Discard unsaved changes")
  ;[...host.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent === "Keep editing")!.click()
  host.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await settle(() => !!host.querySelector('[aria-label="Edit Cell biology"]'))
  expect(snapshot.profiles[0].skillNames).toEqual(["scanpy"])
  expect(snapshot.profiles[0].name).toBe("biology")
})
