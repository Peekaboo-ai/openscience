import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { ArtifactPublication } from "../../src/artifact/publication"
import { ArtifactStore } from "../../src/artifact/store"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { MessageV2 } from "../../src/session/message-v2"
import { FileRoutes } from "../../src/server/routes/file"
import { tmpdir } from "../fixture/fixture"

afterEach(() => ArtifactStore.reset())

async function answer(sessionID: string, text: string, over: Partial<MessageV2.Assistant> = {}) {
  const id = Identifier.ascending("message")
  await Session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    parentID: Identifier.ascending("message"),
    modelID: "test",
    providerID: "test",
    mode: "research",
    agent: "research",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
    ...over,
  })
  await Session.updatePart({ id: Identifier.ascending("part"), sessionID, messageID: id, type: "text", text })
  return { sessionID, messageID: id, messageIDs: [id] }
}

async function publish(input: { sessionID: string; messageID: string; messageIDs?: string[] }) {
  const response = await FileRoutes().request("/file/artifacts/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  expect(response.status).toBe(200)
  return ArtifactPublication.Report.parse(await response.json())
}

describe("completed output publication", () => {
  test("parses real markdown delivery links while excluding examples and web citations", () => {
    expect(
      ArtifactPublication.paths(
        [
          "[Report](<results/report (final).md>) and ![Figure](figures/plot.png)",
          "[Data][result]",
          "[result]: results/metrics%20final.tsv",
          "[Same](figures/plot.png) [Citation](https://example.org/paper.pdf)",
          "`[Inline example](example.md)`",
          "```md\n[Example](example.csv)\n```",
          "[Structure](sandbox:/tmp/1CA2.cif) [Sequence](file:///tmp/aligned.fasta)",
          "[Anchor](#figures) [Folder](results/) [Unsafe](javascript:run())",
        ].join("\n\n"),
      ),
    ).toEqual([
      "results/report (final).md",
      "figures/plot.png",
      "results/metrics final.tsv",
      "/tmp/1CA2.cif",
      "/tmp/aligned.fasta",
    ])
  })

  test("saves linked historical outputs, reuses immutable bytes and survives concurrent reopening", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const root = await SessionFilesystem.workspace(session.id)
        await Bun.write(path.join(root, "report.md"), "# Verified findings")
        await Bun.write(path.join(root, "metrics.tsv"), "protein\tvalue\nCA2\t16")
        await Bun.write(path.join(root, "intermediate.txt"), "not a deliverable")
        const input = await answer(session.id, "[Report](report.md) [Metrics](metrics.tsv)")
        const [first, second] = await Promise.all([publish(input), publish(input)])
        expect(first.artifacts).toHaveLength(2)
        expect(second.artifacts.map((item) => item.currentVersionID)).toEqual(
          first.artifacts.map((item) => item.currentVersionID),
        )
        expect(
          first.artifacts.every(
            (item) => item.current.sessionID === session.id && item.current.messageID === input.messageID,
          ),
        ).toBe(true)
        await Bun.write(path.join(root, "report.md"), "changed working file")
        const repeat = await publish(input)
        const report = repeat.artifacts.find((item) => item.current.filename === "report.md")!
        expect(repeat.published).toBe(0)
        expect(report.versionCount).toBe(1)
        expect(
          await (await ArtifactStore.read(Instance.project.id, report.id, report.current.id))!.content.text(),
        ).toBe("# Verified findings")
      },
    })
  })

  test("isolates sessions sharing a source path and retains the first session's renderer version", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await Session.create({})
        const second = await Session.create({})
        await SessionFilesystem.grant({
          sessionID: first.id,
          path: tmp.path,
          access: "read",
          scope: "project",
          source: "api",
        })
        const target = path.join(tmp.path, "result.csv")
        await Bun.write(target, "value\n1")
        const original = await publish(await answer(first.id, `[Output](<${target.replaceAll("\\", "/")}>)`))
        expect(original.failures).toEqual([])
        await Bun.write(target, "value\n2")
        const changed = await publish(await answer(second.id, `[Output](<${target.replaceAll("\\", "/")}>)`))
        expect(changed.failures).toEqual([])
        const listed = (await (await FileRoutes().request("/file/artifact-store")).json()) as ArtifactStore.Artifact[]
        expect(listed).toHaveLength(2)
        expect(new Set(listed.map((item) => item.current.sessionID))).toEqual(new Set([first.id, second.id]))
        expect(original.artifacts[0]!.id).toBe(changed.artifacts[0]!.id)
        expect(original.artifacts[0]!.currentVersionID).not.toBe(changed.artifacts[0]!.currentVersionID)
        expect(
          await (await ArtifactStore.read(
            Instance.project.id,
            original.artifacts[0]!.id,
            original.artifacts[0]!.currentVersionID,
          ))!.content.text(),
        ).toBe("value\n1")
        const firstResult = listed.find((item) => item.current.sessionID === first.id)!
        expect(firstResult.currentVersionID).toBe(firstResult.current.id)
      },
    })
  })

  test("reports missing and unauthorized files without hiding saved neighbors or restoring Trash", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await Session.create({})
        const second = await Session.create({})
        const root = await SessionFilesystem.workspace(first.id)
        const other = path.join(await SessionFilesystem.workspace(second.id), "private.tsv")
        await Bun.write(path.join(root, "good.md"), "kept")
        await Bun.write(other, "private")
        const input = await answer(first.id, `[Good](good.md) [Missing](missing.csv) [Other](<${other}>)`)
        const result = await publish(input)
        expect(result.artifacts).toHaveLength(1)
        expect(result.failures).toHaveLength(2)
        await ArtifactStore.trash(Instance.project.id, result.artifacts[0]!.id)
        expect((await publish(input)).artifacts).toHaveLength(0)
        expect(await ArtifactStore.list(Instance.project.id, "trash")).toHaveLength(1)
      },
    })
  })

  test("never publishes incomplete answers, failed requests or compaction summaries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Bun.write(path.join(await SessionFilesystem.workspace(session.id), "result.md"), "not delivered")
        for (const over of [
          { time: { created: Date.now() } },
          { finish: "tool-calls" },
          { summary: true },
          { error: { name: "UnknownError", data: { message: "failed" } } } as Partial<MessageV2.Assistant>,
        ])
          expect((await publish(await answer(session.id, "[Output](result.md)", over))).artifacts).toHaveLength(0)
      },
    })
  })

  test("keeps explicit tool publications and rejects oversized captures before streaming", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const root = await SessionFilesystem.workspace(session.id)
        const toolMessage = Identifier.ascending("message")
        await ArtifactStore.save({
          projectID: Instance.project.id,
          sessionID: session.id,
          messageID: toolMessage,
          sourcePath: "kept.md",
          filename: "kept.md",
          kind: "report",
          content: new Blob(["tool saved"]),
          captureQuality: "exact",
        })
        const file = await fs.open(path.join(root, "large.csv"), "w")
        await file.truncate(64 * 1024 * 1024 + 1)
        await file.close()
        const input = await answer(session.id, "[Kept](kept.md) [Large](large.csv)")
        const result = await publish({ ...input, messageIDs: [...input.messageIDs, toolMessage] })
        expect(result.artifacts).toHaveLength(1)
        expect(result.artifacts[0]!.current.captureQuality).toBe("exact")
        expect(result.artifacts[0]!.versionCount).toBe(1)
        expect(result.failures).toHaveLength(1)
        expect(result.failures[0]!.path).toBe("large.csv")
      },
    })
  })
})
