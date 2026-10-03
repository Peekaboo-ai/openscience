import type { TurnArtifactsProps } from "@synsci/ui/context/data"
import { normalizeStoredArtifacts, type StoredArtifact } from "./store"
import type { ArtifactsRequest } from "./resource"
import { requestDeadline } from "@/utils/request-deadline"

export interface TurnArtifactsReport {
  artifacts: StoredArtifact[]
  failures: Array<{ path: string; message: string }>
  published: number
  truncated: boolean
}

export function createArtifactPublication(request: ArtifactsRequest) {
  const cache = new Map<string, Promise<TurnArtifactsReport>>()
  return (scope: string, turn: TurnArtifactsProps, refresh = false) => {
    const key = JSON.stringify([scope, turn.sessionID, turn.finalMessageID, turn.messageIDs])
    if (!refresh && cache.has(key)) return cache.get(key)!
    const result = requestDeadline(async (signal) => {
      const response = await request(
        turn.finalMessageID ? "/file/artifacts/publish" : "/file/artifact-store?state=active",
        {
          signal,
          ...(turn.finalMessageID
            ? {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  sessionID: turn.sessionID,
                  messageID: turn.finalMessageID,
                  messageIDs: turn.messageIDs.slice(-500),
                }),
              }
            : {}),
        },
      )
      if (!response.ok) throw new Error(`Results unavailable (${response.status})`)
      const value = await response.json()
      const report = turn.finalMessageID ? (value as TurnArtifactsReport) : undefined
      if (report ? !Array.isArray(report.artifacts) : !Array.isArray(value))
        throw new Error("Results metadata is invalid")
      const artifacts = normalizeStoredArtifacts(report ? report.artifacts : value).filter(
        (item) =>
          item.state === "active" &&
          item.current.sessionID === turn.sessionID &&
          !!item.current.messageID &&
          turn.messageIDs.includes(item.current.messageID),
      )
      return {
        artifacts,
        failures: Array.isArray(report?.failures)
          ? report.failures.filter((item) => item && typeof item.path === "string" && typeof item.message === "string")
          : [],
        published: typeof report?.published === "number" ? report.published : 0,
        truncated: report?.truncated === true,
      }
    }, 60_000)
    cache.set(key, result)
    if (cache.size > 100) cache.delete(cache.keys().next().value!)
    void result.then(
      (report) => {
        if (report.failures.length && cache.get(key) === result) cache.delete(key)
      },
      () => {
        if (cache.get(key) === result) cache.delete(key)
      },
    )
    return result
  }
}

export function orderTurnArtifacts(artifacts: StoredArtifact[]): StoredArtifact[] {
  const priority = (item: StoredArtifact) => {
    if (/\.(?:md|markdown|html|htm|ipynb)$/i.test(item.current.filename)) return 0
    if (item.kind === "figure" || /\.pdf$/i.test(item.current.filename)) return 1
    if (item.kind === "structure") return 2
    if (item.kind === "dataset") return 3
    if (item.kind === "archive") return 6
    return 4
  }
  return artifacts.toSorted(
    (left, right) => priority(left) - priority(right) || left.current.filename.localeCompare(right.current.filename),
  )
}
