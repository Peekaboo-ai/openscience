import { createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { requestStoredArtifact, type ArtifactTransport } from "./bytes"
import { normalizeStoredArtifact, type StoredArtifact, type StoredArtifactVersion } from "./store"

export function createStoredArtifactActions(input: {
  artifact: Accessor<StoredArtifact>
  scope: Accessor<string>
  request: ArtifactTransport
  renamed: (artifact: StoredArtifact) => void
  removed: (id: string) => void
  downloaded: (filename: string, blob: Blob) => void
  failed: (operation: "rename" | "delete" | "download", error: unknown) => void
}) {
  const owner = createMemo(() => ({ scope: input.scope(), id: input.artifact().id }))
  const [state, setState] = createStore({ busy: false, downloading: false })
  let mounted = true
  onCleanup(() => (mounted = false))
  createEffect(() => {
    owner()
    setState({ busy: false, downloading: false })
  })
  // 回调只属于点击时的视图；切换项目或制品后，旧响应不能改标题、关闭新标签或解锁新请求。
  const owns = (ticket: ReturnType<typeof owner>) => mounted && owner() === ticket

  return {
    state,
    async rename(value: string) {
      const title = value.trim()
      if (!title || state.busy) return
      const ticket = owner()
      setState("busy", true)
      try {
        const response = await input.request(`/file/artifact-store/${encodeURIComponent(ticket.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        })
        if (!response.ok) throw new Error((await response.text()) || `Rename failed (${response.status})`)
        const updated = normalizeStoredArtifact(await response.json())
        if (!updated || updated.id !== ticket.id) throw new Error("The renamed Result record is malformed.")
        if (owns(ticket)) input.renamed(updated)
      } catch (error) {
        if (owns(ticket)) input.failed("rename", error)
      } finally {
        if (owns(ticket)) setState("busy", false)
      }
    },
    async remove() {
      if (state.busy) return
      const ticket = owner()
      setState("busy", true)
      try {
        const response = await input.request(`/file/artifact-store/${encodeURIComponent(ticket.id)}`, {
          method: "DELETE",
        })
        if (!response.ok) throw new Error((await response.text()) || `Delete failed (${response.status})`)
        if (owns(ticket)) input.removed(ticket.id)
      } catch (error) {
        if (owns(ticket)) input.failed("delete", error)
      } finally {
        if (owns(ticket)) setState("busy", false)
      }
    },
    async download(version: StoredArtifactVersion) {
      if (state.downloading || version.artifactID !== owner().id) return
      const ticket = owner()
      setState("downloading", true)
      try {
        const response = await requestStoredArtifact(input.request, ticket.id, version.id, true)
        const blob = await response.blob()
        if (owns(ticket)) input.downloaded(version.filename, blob)
      } catch (error) {
        if (owns(ticket)) input.failed("download", error)
      } finally {
        if (owns(ticket)) setState("downloading", false)
      }
    },
  }
}
