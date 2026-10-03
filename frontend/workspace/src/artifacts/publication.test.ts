import { describe, expect, test } from "bun:test"
import { createArtifactPublication, orderTurnArtifacts } from "./publication"
import type { StoredArtifact } from "./store"

export const artifact = (
  id: string,
  filename = `${id}.zip`,
  over: Partial<StoredArtifact["current"]> = {},
): StoredArtifact => ({
  schemaVersion: 1,
  id: `art_${id}`,
  projectID: "prj_a",
  title: filename,
  kind: "archive",
  currentVersionID: `ver_${id}`,
  createdAt: 1,
  updatedAt: 1,
  state: "active",
  versionCount: 1,
  current: {
    id: `ver_${id}`,
    artifactID: `art_${id}`,
    version: 1,
    filename,
    mimeType: "application/zip",
    size: 1,
    sha256: "a".repeat(64),
    sessionID: "ses_a",
    messageID: "msg_final",
    sourcePath: filename,
    captureQuality: "declared",
    createdAt: 1,
    ...over,
  },
})

const turn = { sessionID: "ses_a", messageIDs: ["msg_tool", "msg_final"], finalMessageID: "msg_final" }

describe("turn artifact publication", () => {
  test("sends the completed turn identity and excludes foreign sessions and messages", async () => {
    const sent: Array<{ path: string; input: unknown }> = []
    const load = createArtifactPublication(async (path, init) => {
      sent.push({ path, input: JSON.parse(String(init?.body)) })
      return Response.json({
        artifacts: [
          artifact("kept"),
          artifact("foreign", "foreign.zip", { sessionID: "ses_b" }),
          artifact("earlier", "earlier.zip", { messageID: "msg_previous" }),
        ],
        published: 1,
        failures: [],
        truncated: false,
      })
    })
    const report = await load("project_a", turn)
    expect(report.artifacts.map((item) => item.id)).toEqual(["art_kept"])
    expect(sent).toEqual([
      {
        path: "/file/artifacts/publish",
        input: { sessionID: "ses_a", messageID: "msg_final", messageIDs: turn.messageIDs },
      },
    ])
  })

  test("shares repeated loads and isolates the cache by server and project scope", async () => {
    let calls = 0
    const load = createArtifactPublication(async () => {
      calls += 1
      return Response.json({ artifacts: [artifact("kept")], published: 0, failures: [], truncated: false })
    })
    await Promise.all([load("server_a/project_a", turn), load("server_a/project_a", turn)])
    expect(calls).toBe(1)
    await load("server_b/project_a", turn)
    expect(calls).toBe(2)
    await load("server_a/project_a", turn, true)
    expect(calls).toBe(3)
  })

  test("retries transport and individual capture failures without caching an unavailable result", async () => {
    let calls = 0
    const load = createArtifactPublication(async () => {
      calls += 1
      if (calls === 1) return new Response("offline", { status: 503 })
      return Response.json({
        artifacts: [artifact("kept")],
        published: 0,
        failures: calls === 2 ? [{ path: "missing.csv", message: "not found" }] : [],
        truncated: false,
      })
    })
    await expect(load("project_a", turn)).rejects.toThrow("503")
    expect((await load("project_a", turn)).failures).toHaveLength(1)
    expect((await load("project_a", turn)).failures).toHaveLength(0)
    expect(calls).toBe(3)
  })

  test("orders reports, visual results and structures before downloadable bundles", () => {
    const rows = [
      artifact("bundle"),
      { ...artifact("table", "metrics.tsv"), kind: "dataset" },
      { ...artifact("structure", "1CA2.cif"), kind: "structure" },
      artifact("report", "report.md"),
      artifact("figure", "hydropathy.pdf"),
    ]
    expect(orderTurnArtifacts(rows).map((item) => item.current.filename)).toEqual([
      "report.md",
      "hydropathy.pdf",
      "1CA2.cif",
      "metrics.tsv",
      "bundle.zip",
    ])
    expect(rows[0]!.current.filename).toBe("bundle.zip")
  })
})
