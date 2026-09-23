import z from "zod"
import path from "node:path"
import { Global } from "../global"
import { JsonStore } from "../util/jsonstore"
import { Target, prepare } from "./transport"
import { RemoteClient } from "./client"

export namespace RemoteWorkspaces {
  export const Bookmark = z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    target: Target,
    directory: z.string().optional(),
    projectID: z.string().optional(),
    created: z.number(),
  })
  export type Bookmark = z.infer<typeof Bookmark>
  export const Status = Bookmark.extend({
    state: z.enum(["disconnected", "connecting", "connected", "error"]),
    progress: z.string(),
    error: z.string().optional(),
    home: z.string().optional(),
  })
  type Active = {
    abort: AbortController
    state: "connecting" | "connected" | "error"
    progress: string
    error?: string
    home?: string
    client?: RemoteClient
  }
  const active = new Map<string, Active>()
  const file = () => path.join(Global.Path.data, "remote-workspaces.json")
  export async function bookmarks() {
    return z.array(Bookmark).parse((await JsonStore.read(file(), { strict: true })).bookmarks ?? [])
  }
  export async function list() {
    return (await bookmarks()).map(status)
  }
  function status(bookmark: Bookmark) {
    const state = active.get(bookmark.id)
    return Status.parse({
      ...bookmark,
      state: state?.state ?? "disconnected",
      progress: state?.progress ?? "Disconnected",
      error: state?.error,
      home: state?.home,
    })
  }
  export async function get(id: string) {
    const bookmark = (await bookmarks()).find((item) => item.id === id)
    if (!bookmark) throw new Error("Remote workspace not found")
    return bookmark
  }
  export async function create(input: { name: string; target: Target }) {
    const bookmark = Bookmark.parse({ ...input, id: crypto.randomUUID(), created: Date.now() })
    await JsonStore.update(file(), (draft) => {
      draft.bookmarks = [...z.array(Bookmark).parse(draft.bookmarks ?? []), bookmark]
    })
    return status(bookmark)
  }
  export async function connect(id: string) {
    const bookmark = await get(id)
    const current = active.get(id)
    if (current && current.state !== "error") return status(bookmark)
    const entry: Active = { abort: new AbortController(), state: "connecting", progress: "Preparing connection…" }
    active.set(id, entry)
    void prepare(bookmark.target, entry.abort.signal, (value) => {
      entry.progress = value
    })
      .then(async (proc) => {
        const client = new RemoteClient(proc, (error) => {
          if (active.get(id) === entry && !entry.abort.signal.aborted) {
            entry.state = "error"
            entry.error = error.message
          }
        })
        entry.client = client
        const timer = setTimeout(() => client.close(new Error("Remote backend handshake timed out")), 90_000)
        try {
          entry.home = await client.ready
        } finally {
          clearTimeout(timer)
        }
        // 取消或重连后的迟到握手不能重新激活旧连接。
        if (entry.abort.signal.aborted || active.get(id) !== entry) {
          client.close()
          return
        }
        entry.state = "connected"
        entry.progress = "Connected"
      })
      .catch((error) => {
        if (active.get(id) !== entry || entry.abort.signal.aborted) return
        entry.state = "error"
        entry.error = error instanceof Error ? error.message : "Connection failed"
      })
    return status(bookmark)
  }
  export function client(id: string) {
    const entry = active.get(id)
    if (entry?.state !== "connected" || !entry.client)
      throw new Error("Remote workspace is disconnected. Reconnect to continue.")
    return entry.client
  }
  export function disconnect(id: string) {
    const entry = active.get(id)
    active.delete(id)
    if (entry?.client) entry.client.close()
    else entry?.abort.abort()
  }
  export async function remove(id: string) {
    disconnect(id)
    await JsonStore.update(file(), (draft) => {
      draft.bookmarks = z
        .array(Bookmark)
        .parse(draft.bookmarks ?? [])
        .filter((item) => item.id !== id)
    })
  }
  export async function bind(id: string, directory: string, projectID: string, name?: string) {
    await JsonStore.update(file(), (draft) => {
      draft.bookmarks = z
        .array(Bookmark)
        .parse(draft.bookmarks ?? [])
        .map((item) => (item.id === id ? { ...item, directory, projectID, name: name ?? item.name } : item))
    })
    return status(await get(id))
  }
}
