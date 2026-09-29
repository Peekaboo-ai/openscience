import type { StoredArtifact } from "@/artifacts/store"
import { resolveViewer } from "./viewer-registry"

export const ARTIFACT_TYPES = [
  { value: "all", label: "All types" },
  { value: "image", label: "Figures & images" },
  { value: "structure", label: "Molecular structures" },
  { value: "data", label: "Tables & scientific data" },
  { value: "document", label: "Reports & notebooks" },
  { value: "other", label: "Other files" },
] as const
export type ArtifactType = (typeof ARTIFACT_TYPES)[number]["value"]

export function artifactType(artifact: StoredArtifact): ArtifactType {
  const viewer = resolveViewer({ name: artifact.current.filename, mimeType: artifact.current.mimeType })
  if (viewer.kind === "image") return "image"
  if (viewer.kind === "science")
    return /^(pdb|ent|cif|mmcif|pdbqt|gro|xyz|sdf|mol|mol2|smi|smiles)$/.test(viewer.extension) ? "structure" : "data"
  if (viewer.kind === "table" || viewer.kind === "scientific-data") return "data"
  if (["markdown", "html", "pdf", "notebook"].includes(viewer.kind)) return "document"
  return "other"
}

export function filterArtifacts(list: StoredArtifact[], input: { session?: string; type: ArtifactType }) {
  return list.filter(
    (artifact) =>
      (input.session === undefined || artifact.current.sessionID === input.session) &&
      (input.type === "all" || artifactType(artifact) === input.type),
  )
}
