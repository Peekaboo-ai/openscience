import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../test/vite"

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
const subject = (await server.ssrLoadModule("/src/science/ScienceArtifact.tsx")) as typeof import("./ScienceArtifact")
const registry = (await server.ssrLoadModule(
  "/src/science/renderers/registry.ts",
)) as typeof import("./renderers/registry")
const solidjs = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const cleanups: Array<() => void> = []
const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("a failed renderer preserves sibling content and recovers when corrected artifact data arrives", async () => {
  registry.register("test-invalid-data", (props) => {
    if (props.data === "broken") throw new Error("Invalid scientific payload")
    return String(props.data)
  })
  const [data, setData] = solidjs.createSignal("broken")
  const host = mount(() => [
    "Conversation stays visible",
    subject.ScienceArtifact({
      kind: "test-invalid-data",
      get data() {
        return data()
      },
    }),
  ])
  await settle()
  expect(host.textContent).toContain("Conversation stays visible")
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Invalid scientific payload")
  expect(host.querySelector("pre")?.textContent).toContain("broken")
  setData("Corrected result")
  await settle()
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.textContent).toContain("Corrected result")
})

test("retry restarts only the failed artifact", async () => {
  let attempts = 0
  registry.register("test-retry-data", () => {
    if (++attempts === 1) throw new Error("Renderer was unavailable")
    return "Recovered artifact"
  })
  const host = mount(() => subject.ScienceArtifact({ kind: "test-retry-data", data: "payload" }))
  await settle()
  const beforeRetry = attempts
  host.querySelector<HTMLButtonElement>("button")!.click()
  await settle()
  expect(host.textContent).toContain("Recovered artifact")
  expect(attempts).toBe(beforeRetry + 1)
})
