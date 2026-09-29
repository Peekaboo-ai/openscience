import z from "zod"
import path from "node:path"
import { Tool } from "./tool"
import { ArtifactStore } from "@/artifact/store"
import { File } from "@/file"
import { ArtifactFile } from "@/file/artifacts"
import { Instance } from "@/project/instance"
import { Provenance } from "@/science/provenance/store"
import { Experiments } from "@/experiments"
import { JobBroker } from "@/compute/job-broker"
import type { Node, Run } from "@/science/provenance/store"
import { Log } from "@/util/log"

const log = Log.create({ service: "tool.artifact" })
// A text window verifies the whole immutable blob. Keep repeated reads bounded;
// larger datasets belong in the download/analysis path, not model context.
const MAX_INLINE_BYTES = 8 * 1024 * 1024

function result(title: string, output: string, metadata: Record<string, unknown> = {}) {
  return { title, output, metadata }
}

const runnable = (node: Node | undefined): node is Run =>
  node?.kind === "run" && "tool" in node && typeof node.tool === "string"

function savedExecution(run: Run): Omit<ArtifactStore.Execution, "id" | "artifactVersionID" | "createdAt"> {
  const envelope = run.provenance
  const status = (() => {
    switch (envelope?.outputs.status) {
      case "succeeded":
        return "succeeded" as const
      case "failed":
        return "failed" as const
      case "cancelled":
      case "interrupted":
        return "cancelled" as const
      default:
        return "unknown" as const
    }
  })()
  const files = (envelope?.outputs.items ?? []).flatMap((item) =>
    item.path.status === "available" ? [{ path: item.path.value, sha256: item.sha256, size: item.size }] : [],
  )
  return {
    command: run.tool,
    ...(envelope?.input.code.status === "available" ? { code: envelope.input.code.value } : {}),
    status,
    ...(typeof run.meta?.stdout === "string" ? { stdout: run.meta.stdout } : {}),
    ...(typeof run.meta?.stderr === "string" ? { stderr: run.meta.stderr } : {}),
    ...(typeof run.meta?.effort === "string" ? { effort: run.meta.effort } : {}),
    source: run.id,
    ...(run.inputs ? { inputs: run.inputs } : {}),
    captureQuality: envelope ? "exact" : "declared",
    files,
    ...(envelope
      ? {
          environment: {
            host: envelope.environment.host,
            kernel: envelope.environment.kernel,
            runID: envelope.identity.run_id,
          },
        }
      : {}),
  }
}

async function traceSavedArtifact(saved: ArtifactStore.Artifact, run?: Run) {
  const scope = { projectID: Instance.project.id, directory: Instance.directory }
  const version = saved.current
  const id = ArtifactStore.reviewTargetID(version.id, version.sha256)
  const existing = await Provenance.find(scope, id)
  if (
    existing &&
    (existing.kind !== "artifact" ||
      !("contentHash" in existing) ||
      existing.contentHash !== version.sha256 ||
      existing.meta?.artifactID !== saved.id ||
      existing.meta?.versionID !== version.id)
  ) {
    throw new Error(`Provenance target ${id} conflicts with the immutable artifact version`)
  }
  if (!existing) {
    await Provenance.recordOwned(scope, {
      id,
      kind: "artifact",
      label: `${saved.title} · version ${version.version}`,
      artifactType: saved.kind,
      path: version.sourcePath,
      contentHash: version.sha256,
      size: version.size,
      meta: {
        artifactStore: true,
        artifactID: saved.id,
        versionID: version.id,
        version: version.version,
        filename: version.filename,
        mimeType: version.mimeType,
        sha256: version.sha256,
        sessionID: version.sessionID,
        sourcePath: version.sourcePath,
        captureQuality: version.captureQuality,
      },
    } as Parameters<typeof Provenance.record>[0])
  }
  if (run) await Provenance.linkOwned(scope, { from: run.id, to: id, relation: "produced" })
}

/**
 * The runs a model actually names when it saves a Result are its study runs
 * and compute jobs, which live in their own stores rather than the
 * provenance graph. Bring the named one into the graph, so the Result's
 * lineage points at the run that produced it, provided the run belongs to
 * this session and project.
 */
async function recordedRun(
  scope: { projectID: string; directory: string },
  id: string,
  sessionID: string,
): Promise<Node | undefined> {
  const run = await Experiments.getRun(id).catch(() => undefined)
  if (run) {
    const study = run.studyID ? await Experiments.getStudy(run.studyID).catch(() => undefined) : undefined
    if ((run.sessionID ?? study?.sessionID) !== sessionID) return
    return Provenance.recordOwned(scope, {
      id,
      kind: "run",
      label: `Study run: ${run.name}`,
      tool: "study",
      sessionID,
      inputs: {
        config: run.config,
        ...(run.jobID ? { jobID: run.jobID } : {}),
        ...(run.studyID ? { studyID: run.studyID } : {}),
      },
      status: run.status === "finished" ? "ok" : "error",
      meta: {
        projectID: scope.projectID,
        sessionID,
        runID: run.id,
        runStatus: run.status,
        ...(run.jobID ? { jobID: run.jobID } : {}),
        ...(run.headline !== null ? { headline: run.headline } : {}),
        ...(study ? { studyID: study.id, metric: study.metric } : {}),
      },
    } as Parameters<typeof Provenance.record>[0])
  }
  const { computeOptions } = await import("./compute-job")
  const job = await computeOptions(sessionID)
    .then((options) => JobBroker.get(id, options))
    .catch(() => undefined)
  if (!job || job.session_id !== sessionID) return
  return Provenance.recordOwned(scope, {
    id,
    kind: "run",
    label: `Compute job: ${job.name}`,
    tool: "compute_job",
    sessionID,
    inputs: { command: job.command, ...(job.cwd ? { cwd: job.cwd } : {}), target: job.target },
    status: job.status === "succeeded" ? "ok" : "error",
    meta: { projectID: scope.projectID, sessionID, jobID: job.id, jobStatus: job.status, target: job.target_label },
  } as Parameters<typeof Provenance.record>[0])
}

export const ArtifactTool = Tool.define("artifact", {
  description:
    "Save an important workspace file as a durable Result, or read an exact immutable Result version by artifact_id and version_id (including outputs handed back by a worker). When saving a research archive, include preview_paths for the key figures, structures, tables and report: these are saved as separate Results in the same session before the download bundle. An archive alone cannot be previewed. read_file returns bounded text or binary metadata; it does not grant access to another session's scratch. Empirical contract Results need provenance_id to pass completion. Keep drafts and large mutable working data in the workspace instead.",
  parameters: z
    .object({
      action: z.enum(["save_file", "read_file"]),
      path: z.string().trim().min(1).max(10_000).optional().describe("Required for save_file: workspace file path"),
      summary: z.string().optional().describe("Concise user-facing Result title"),
      preview_paths: z
        .array(z.string().trim().min(1).max(10_000))
        .min(1)
        .max(32)
        .optional()
        .describe(
          "For save_file: key workspace files to publish individually alongside the archive. Choose one preview per figure, meaningful result tables, molecular structures and the report; exclude raw inputs, logs and duplicate formats. These files must already exist outside the archive. Each inherits this call's session and provenance_id; use separate save_file calls when producing runs differ.",
        ),
      download_only_reason: z
        .string()
        .trim()
        .min(1)
        .max(1_000)
        .optional()
        .describe(
          "For archives with no useful previewable content (e.g. raw data or source code only), explain why no preview_paths apply. Do not use this to omit available research figures, structures, tables or reports.",
        ),
      preview_artifact_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(32)
        .optional()
        .describe(
          "Already saved key Result IDs from this session to accompany the archive without creating new versions. Use this for files saved separately with different producing-run provenance.",
        ),
      provenance_id: z
        .string()
        .optional()
        .describe(
          "The producing run from this session: a study run id (exp_…), a compute job id, or a recorded provenance id. Required for empirical contract Results to pass completion.",
        ),
      artifact_id: z.string().min(1).optional().describe("Required for read_file: exact saved artifact ID"),
      version_id: z.string().min(1).optional().describe("Required for read_file: exact immutable version ID"),
      offset: z.number().int().nonnegative().optional().describe("Byte offset for the next bounded text window"),
    })
    .superRefine((input, ctx) => {
      for (const field of input.action === "save_file"
        ? (["path"] as const)
        : (["artifact_id", "version_id"] as const)) {
        if (!input[field])
          ctx.addIssue({ code: "custom", path: [field], message: `${field} is required for ${input.action}` })
      }
    }),
  async execute(params, ctx) {
    if (params.action === "read_file") {
      ctx.abort.throwIfAborted()
      const detail = await ArtifactStore.get(Instance.project.id, params.artifact_id!)
      const version = detail?.versions.find((item) => item.id === params.version_id)
      if (version && version.size > MAX_INLINE_BYTES) {
        return result(
          `Saved Result: ${version.filename}`,
          "This Result exceeds the 8 MiB inline-text limit. Retrieve this exact version through Files > Results or the artifact API and analyze it as a file. This response contains stored metadata only; it has not verified or read the blob bytes.",
          {
            artifactID: version.artifactID,
            versionID: version.id,
            size: version.size,
            sha256: version.sha256,
            readStatus: "metadata_only",
          },
        )
      }
      const stored = await ArtifactStore.read(Instance.project.id, params.artifact_id!, params.version_id!)
      if (!stored)
        throw new Error("This artifact version is unavailable or failed integrity verification in the current project.")
      const info = stored.info
      const offset = params.offset ?? 0
      if (offset > info.size) throw new Error(`Byte offset ${offset} exceeds artifact size ${info.size}.`)
      const bytes = new Uint8Array(await stored.content.slice(offset, offset + 50 * 1024).arrayBuffer())
      ctx.abort.throwIfAborted()
      const metadata = {
        artifactID: info.artifactID,
        versionID: info.id,
        filename: info.filename,
        size: info.size,
        sha256: info.sha256,
        mimeType: info.mimeType,
        offset,
        readStatus: "verified",
      }
      const textual = info.mimeType.startsWith("text/") || /(?:json|xml|yaml|javascript)/i.test(info.mimeType)
      if (!textual || bytes.includes(0)) {
        return result(
          `Saved Result: ${info.filename}`,
          "This is a binary Result. Open it from Files > Results or retrieve the exact version through the artifact API; it is not a text document.",
          metadata,
        )
      }
      // Streaming decode leaves an incomplete trailing UTF-8 sequence for the
      // next window instead of corrupting it at the byte boundary.
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      const text = (() => {
        try {
          return decoder.decode(bytes, { stream: offset + bytes.length < info.size })
        } catch {
          throw new Error(
            "This window is not valid UTF-8 text. Use the returned byte offset from the preceding window, or retrieve the Result as a file to decode its original encoding.",
          )
        }
      })()
      const end = offset + new TextEncoder().encode(text).length
      const more = end < info.size
      return result(
        `Saved Result: ${info.filename}`,
        text + (more ? `\n\n[More content: call artifact read_file with the same IDs and offset=${end}.]` : ""),
        { ...metadata, nextOffset: more ? end : undefined, truncated: more },
      )
    }
    const scope = { projectID: Instance.project.id, directory: Instance.directory }
    const node = params.provenance_id
      ? ((await Provenance.find(scope, params.provenance_id)) ??
        (await recordedRun(scope, params.provenance_id, ctx.sessionID)))
      : undefined
    const entry = runnable(node) ? node : undefined
    const sessionID =
      entry?.sessionID ?? (typeof entry?.meta?.sessionID === "string" ? entry.meta.sessionID : undefined)
    const owner =
      entry?.provenance?.identity.project_id.status === "available"
        ? entry.provenance.identity.project_id.value
        : typeof entry?.meta?.projectID === "string"
          ? entry.meta.projectID
          : undefined
    if (params.provenance_id && (!entry || sessionID !== ctx.sessionID || owner !== Instance.project.id)) {
      return result("Invalid provenance", "The producing run was not found in this project and session.")
    }
    const archive = ArtifactFile.classify(params.path!)?.kind === "archive"
    const previews = [...new Set(params.preview_paths ?? [])]
    const references = [...new Set(params.preview_artifact_ids ?? [])]
    if (archive && !previews.length && !references.length && !params.download_only_reason) {
      throw new Error(
        "Research bundles must include independently viewable Results. Call save_file again with preview_paths naming the key existing figures, structures, tables and report outside the archive, or preview_artifact_ids for Results already saved in this session. Keep the archive for full download. If it contains only raw data or source code with no useful preview, supply download_only_reason.",
      )
    }
    const published = []
    for (const id of references) {
      ctx.abort.throwIfAborted()
      const saved = await ArtifactStore.get(Instance.project.id, id)
      if (!saved || saved.state !== "active" || saved.kind === "archive" || saved.current.sessionID !== ctx.sessionID) {
        throw new Error(`Preview Result must be an active individual file saved in this session: ${id}`)
      }
      published.push(
        result(saved.title, `${saved.title}: ${saved.id} (${saved.currentVersionID})`, {
          savedArtifact: {
            id: saved.id,
            versionID: saved.currentVersionID,
            version: saved.current.version,
            title: saved.title,
            size: saved.current.size,
            mimeType: saved.current.mimeType,
            path: saved.current.sourcePath,
            kind: saved.kind,
            sha256: saved.current.sha256,
          },
        }),
      )
    }
    // 先校验整组文件，防止缺失或越权路径导致只交付压缩包；不解压或猜测相邻文件。
    for (const source of [params.path!, ...previews]) {
      ctx.abort.throwIfAborted()
      if (previews.includes(source) && (source === params.path || ArtifactFile.classify(source)?.kind === "archive")) {
        throw new Error(`Preview paths must identify individual files, not download bundles: ${source}`)
      }
      const file = await File.rawSource(source, { sessionID: ctx.sessionID, maxBytes: ArtifactStore.MAX_VERSION_BYTES })
      await file.close()
    }
    const save = async (source: string, summary?: string, inline = true) => {
      ctx.abort.throwIfAborted()
      const file = await File.rawSource(source, {
        sessionID: ctx.sessionID,
        maxBytes: ArtifactStore.MAX_VERSION_BYTES,
      })
      const name = path.basename(source)
      const classified = ArtifactFile.classify(name)
      const title = summary?.trim() || name
      const saved = await ArtifactStore.save({
        projectID: Instance.project.id,
        sessionID: ctx.sessionID,
        sourcePath: source,
        filename: name,
        kind: classified?.kind ?? "file",
        content: file,
        title,
        mimeType: file.mimeType,
        messageID: ctx.messageID,
        captureQuality: "declared",
        ...(entry ? { execution: savedExecution(entry) } : {}),
      }).finally(() => file.close())
      const preview = await (async () => {
        if (!inline || saved.current.size > 1_500_000) return
        const stored = await ArtifactStore.read(Instance.project.id, saved.id, saved.currentVersionID)
        if (!stored) return
        if (saved.current.mimeType.startsWith("image/")) {
          const bytes = Buffer.from(await stored.content.arrayBuffer()).toString("base64")
          return { kind: "image" as const, data: `data:${saved.current.mimeType};base64,${bytes}` }
        }
        const text =
          saved.current.mimeType.startsWith("text/") ||
          ["application/json", "application/xml", "application/yaml", "application/x-yaml"].includes(
            saved.current.mimeType,
          )
        if (text && saved.current.size <= 250_000) {
          return { kind: "text" as const, data: (await stored.content.text()).slice(0, 12_000) }
        }
      })()
      await traceSavedArtifact(saved, entry).catch((error) => {
        if (entry) throw error
        log.warn("saved Result has no provenance target", {
          sessionID: ctx.sessionID,
          artifactID: saved.id,
          versionID: saved.currentVersionID,
          error,
        })
      })
      return result(
        `Saved Result: ${saved.title}`,
        [
          "Workspace file saved as a durable Result with an immutable version.",
          `  ID: ${saved.id}`,
          `  Version: ${saved.current.version}`,
          `  Kind: ${saved.kind}`,
          `  Path: ${saved.current.sourcePath}`,
          `  Size: ${saved.current.size} bytes`,
          `  SHA-256: ${saved.current.sha256}`,
          "",
          "The Result is available project-wide in Files and can be opened, reviewed, renamed, versioned, or downloaded.",
        ].join("\n"),
        {
          savedArtifact: {
            id: saved.id,
            versionID: saved.currentVersionID,
            version: saved.current.version,
            title: saved.title,
            kind: saved.kind,
            path: saved.current.sourcePath,
            mimeType: saved.current.mimeType,
            size: saved.current.size,
            sha256: saved.current.sha256,
            ...(entry ? { provenanceID: entry.id } : {}),
            ...(preview ? { preview } : {}),
          },
        },
      )
    }
    for (const source of previews) published.push(await save(source, undefined, false))
    const saved = await save(params.path!, params.summary)
    if (!published.length) return saved
    return result(
      saved.title,
      [
        saved.output,
        "",
        "Independent Results are available in Files > Results under this session:",
        ...published.map((item) => item.output),
      ].join("\n"),
      { ...saved.metadata, previewArtifacts: published.map((item) => item.metadata.savedArtifact) },
    )
  },
})
