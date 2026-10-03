import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../test/vite"
import type { StoredArtifact } from "./store"
import type { TurnArtifactsReport } from "./publication"

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
const [subject, web, reactive] = await Promise.all([
  server.ssrLoadModule("/src/artifacts/SessionArtifacts.tsx") as Promise<typeof import("./SessionArtifacts")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
  server.ssrLoadModule("solid-js/store") as Promise<typeof import("solid-js/store")>,
])
const cleanups: Array<() => void> = []
afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  document.body.replaceChildren()
})
const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
const artifact = (index: number): StoredArtifact => ({
  schemaVersion: 1,
  id: `art_${index}`,
  projectID: "prj_a",
  title: `Result ${index}`,
  kind: "archive",
  currentVersionID: `ver_${index}`,
  createdAt: 1,
  updatedAt: 1,
  state: "active",
  versionCount: 2,
  current: {
    id: `ver_${index}`,
    artifactID: `art_${index}`,
    version: 1,
    filename: `output_${index}.zip`,
    mimeType: "application/zip",
    size: 1,
    sha256: "a".repeat(64),
    sessionID: "ses_a",
    messageID: "msg_final",
    sourcePath: `output_${index}.zip`,
    captureQuality: "declared",
    createdAt: 1,
  },
})
const report = (count: number): TurnArtifactsReport => ({
  artifacts: Array.from({ length: count }, (_, index) => artifact(index)),
  failures: [],
  published: 0,
  truncated: false,
})
const props = () => ({
  scope: "server_a/project_a",
  sessionID: "ses_a",
  messageIDs: ["msg_final"],
  finalMessageID: "msg_final",
  load: async () => report(8),
  request: async () => new Response(""),
  onOpen: (_artifact: StoredArtifact) => {},
  onOpenFile: (_path: string) => {},
})

describe("completed response gallery", () => {
  test("renders five thumbnails, expands the remainder, and opens the producing version", async () => {
    const opened: StoredArtifact[] = []
    const host = mount(() => subject.SessionArtifacts({ ...props(), onOpen: (item) => opened.push(item) }))
    await settle()
    expect(host.querySelectorAll("[data-generated-artifact]")).toHaveLength(5)
    expect(host.querySelectorAll(".artifact-thumb")).toHaveLength(5)
    expect(host.textContent).toContain("+3 more")
    host.querySelector<HTMLButtonElement>("[data-generated-artifact]")!.click()
    expect(opened[0]!.current.id).toBe("ver_0")
    host.querySelector<HTMLButtonElement>(".session-artifacts__more")!.click()
    expect(host.querySelectorAll("[data-generated-artifact]")).toHaveLength(8)
    host.querySelector<HTMLButtonElement>(".session-artifacts__collapse")!.click()
    expect(host.querySelectorAll("[data-generated-artifact]")).toHaveLength(5)
  })

  test("keeps available cards when one file failed and offers a usable retry", async () => {
    let calls = 0
    const host = mount(() =>
      subject.SessionArtifacts({
        ...props(),
        load: async () => {
          calls += 1
          return { ...report(1), failures: calls === 1 ? [{ path: "missing.tsv", message: "File not found" }] : [] }
        },
      }),
    )
    await settle()
    expect(host.querySelectorAll("[data-generated-artifact]")).toHaveLength(1)
    expect(host.textContent).toContain("1 file could not be saved")
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Retry saving"),
    )!
    retry.click()
    await settle()
    expect(calls).toBe(2)
    expect(host.querySelector(".session-artifacts__failures")).toBeNull()
  })

  test("ignores a late response from the previously displayed conversation", async () => {
    const deferred: { resolve?: (value: TurnArtifactsReport) => void } = {}
    const [turn, setTurn] = reactive.createStore({ sessionID: "ses_a", finalMessageID: "msg_final" })
    const host = mount(() =>
      subject.SessionArtifacts({
        ...props(),
        get sessionID() {
          return turn.sessionID
        },
        get finalMessageID() {
          return turn.finalMessageID
        },
        load: async (_scope, input) =>
          input.sessionID === "ses_a"
            ? new Promise((resolve) => {
                deferred.resolve = resolve
              })
            : report(1),
      }),
    )
    setTurn({ sessionID: "ses_b", finalMessageID: "msg_other" })
    await settle()
    deferred.resolve!(report(8))
    await settle()
    expect(host.querySelectorAll("[data-generated-artifact]")).toHaveLength(1)
    expect(host.textContent).not.toContain("+3 more")
  })
})
