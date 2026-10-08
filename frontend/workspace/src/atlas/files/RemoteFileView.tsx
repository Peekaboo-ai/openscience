import { Match, Show, Switch, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { IconDownload, IconX } from "@/atlas/shared/Icon"
import { bytes } from "./bytes"
import { thumbLanguage } from "./artifact-thumb"
import { remoteMime, remotePreview, REMOTE_PREVIEW_LIMIT, type RemotePreview } from "./remote-preview"
import { requestDeadline } from "@/utils/request-deadline"
import { resolveViewer } from "./viewer-registry"
import { TextContentView } from "./TextContentView"

export interface RemoteFile {
  name: string
  /** Path inside the Volume, as the listing reported it. */
  path: string
  volume: string
  size?: number
}

export interface RemoteFileViewProps {
  file: RemoteFile
  /** Fetches the file's bytes. Injected so a standalone mount needs no network. */
  read: (file: RemoteFile, signal?: AbortSignal) => Promise<Blob>
  /** 服务、项目及目录快照共同限定缓存；未知归属时不共享缓存。 */
  cacheScope?: string
  onDownload: (file: RemoteFile) => void
  onClose: () => void
  /** Defaults to the shared shiki highlighter; injected in tests. */
  highlight?: (code: string, lang: string) => Promise<string>
}

const shared = (code: string, lang: string) =>
  import("@synsci/ui/context/marked").then((module) => module.highlightSnippet(code, lang))

const visual = (name: string, content: string) =>
  ["science", "scientific-data", "html", "table", "notebook"].includes(resolveViewer({ name, content }).kind)

interface Cached {
  bytes: number
  expires: number
  text?: { body: string; html?: string }
  /** Images keep their data: URL, which needs no revoking and can be reused. */
  dataUrl?: string
  /** PDFs keep the typed bytes; the object URL is remade per mount and revoked. */
  blob?: Blob
}

/**
 * Files already fetched out of a Volume.
 *
 * 关闭后短时间重开可复用字节，但缓存必须属于相同服务、项目和目录快照。
 * 远端文件可原地改写且大小不变，所以即便没有重新列目录也设置短期失效。
 */
const fetched = new Map<string, Cached>()
const CACHE_BUDGET = 32 * 1024 * 1024

const cacheKey = (scope: string, file: RemoteFile) => JSON.stringify([scope, file.volume, file.path, file.size ?? null])

const keep = (key: string | undefined, value: Omit<Cached, "expires">) => {
  if (!key || value.bytes > CACHE_BUDGET) return
  const entry = { ...value, expires: Date.now() + 30_000 }
  let held = entry.bytes
  for (const [existing, value] of fetched) if (existing !== key) held += value.bytes
  // Oldest out first; a preview is worth re-fetching, a wedged tab is not.
  for (const [oldest, value] of fetched) {
    if (held <= CACHE_BUDGET) break
    fetched.delete(oldest)
    held -= value.bytes
  }
  fetched.set(key, entry)
}

export function RemoteFileView(props: RemoteFileViewProps): JSX.Element {
  const [text, setText] = createSignal<{ body: string; html?: string }>()
  const [url, setUrl] = createSignal<string>()
  const [failed, setFailed] = createSignal("")

  const kind = (): RemotePreview | undefined => remotePreview(props.file.name, props.file.size)

  // A signal fed by an effect, never a resource: reading a resource from the
  // render tree suspends the nearest <Suspense>, and this pane renders inside
  // RightPane's.
  createEffect(() => {
    const file = props.file
    const shape = kind()
    const scope = props.cacheScope
    setText(undefined)
    setUrl(undefined)
    setFailed("")
    if (!shape) return

    let live = true
    let revoke: string | undefined
    const controller = new AbortController()
    onCleanup(() => {
      live = false
      controller.abort()
      // The blob is this component's to release; leaving it costs the tab's
      // bytes for the lifetime of the document.
      if (revoke) URL.revokeObjectURL(revoke)
    })

    const key = scope ? cacheKey(scope, file) : undefined
    const cached = key ? fetched.get(key) : undefined
    const hit = cached && cached.expires > Date.now() ? cached : undefined
    if (key && cached && !hit) fetched.delete(key)
    if (hit) {
      if (hit.text) setText(hit.text)
      if (hit.dataUrl) setUrl(hit.dataUrl)
      if (hit.blob) {
        revoke = URL.createObjectURL(hit.blob)
        setUrl(revoke)
      }
      return
    }

    void (async () => {
      try {
        const blob = await requestDeadline((signal) => props.read(file, signal), 45_000, controller.signal)
        if (!live) return
        if (blob.size > REMOTE_PREVIEW_LIMIT)
          throw new Error("This file exceeds the 8 MB preview limit. Download it to view the complete file.")
        if (shape === "text") {
          const body = await blob.text()
          // 内容已到达就可阅读；语法高亮的懒加载不能继续遮住远端文件。
          if (!live) return
          keep(key, { bytes: blob.size, text: { body } })
          setText({ body })
          if (visual(file.name, body)) return
          const html = await (props.highlight ?? shared)(body, thumbLanguage(file.name)).catch(() => undefined)
          if (!live || !html) return
          keep(key, { bytes: blob.size, text: { body, html } })
          setText({ body, html })
          return
        }
        // The app's CSP is img-src 'self' data: https: and frame-src 'self' blob:
        // (server.ts), so the two shapes need different carriers:
        //
        // An image cannot come from a blob: URL at all -- verified in the app,
        // where a valid PNG decodes as data: and fails as blob: -- so its bytes
        // become a data: URL.
        //
        // A PDF may use blob:, but only once it is re-typed: these bytes arrive
        // as application/octet-stream, and an <iframe> handed that downloads the
        // file instead of displaying it.
        const mime = remoteMime(file.name)
        const typed = mime && blob.type !== mime ? new Blob([blob], { type: mime }) : blob
        if (shape === "image") {
          const encoded = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(reader.error ?? new Error("could not decode the image"))
            reader.readAsDataURL(typed)
          })
          if (!live) return
          keep(key, { bytes: typed.size, dataUrl: encoded })
          if (live) setUrl(encoded)
          return
        }
        keep(key, { bytes: typed.size, blob: typed })
        revoke = URL.createObjectURL(typed)
        if (live) setUrl(revoke)
      } catch (error) {
        if (live) setFailed(error instanceof Error ? error.message : String(error))
      }
    })()
  })

  return (
    <section class="remote-view" aria-label={`${props.file.name} in ${props.file.volume}`}>
      <header class="remote-view__bar">
        <span class="remote-view__title">
          <span class="remote-view__name">{props.file.name}</span>
          <span class="remote-view__sub">
            {props.file.volume}
            <Show when={props.file.size !== undefined}> · {bytes(props.file.size)}</Show>
          </span>
        </span>
        <button
          type="button"
          class="remote-view__action"
          data-remote-download
          onClick={() => props.onDownload(props.file)}
        >
          <IconDownload size={12} strokeWidth={1.5} />
          Download
        </button>
        <button
          type="button"
          class="remote-view__action remote-view__action--icon"
          aria-label={`Close ${props.file.name}`}
          onClick={() => props.onClose()}
        >
          <IconX size={12} strokeWidth={1.5} />
        </button>
      </header>

      <div class="remote-view__body atlas-scroll">
        <Switch
          fallback={
            // Not an error: a format this viewer will not guess at, or a file
            // too large to pull whole out of the cloud for a look.
            <div class="remote-view__empty" data-remote-unsupported>
              <p>This file is not previewed here.</p>
              <p class="remote-view__hint">Download it to open it with something that understands the format.</p>
            </div>
          }
        >
          <Match when={failed()}>
            <div class="remote-view__empty" role="status" data-remote-error>
              <p>{props.file.name} could not be read.</p>
              <p class="remote-view__hint">{failed()}</p>
            </div>
          </Match>
          <Match when={kind() === "text" && text()}>
            {(value) => (
              <Show
                when={!visual(props.file.name, value().body)}
                fallback={
                  <TextContentView
                    name={props.file.name}
                    text={value().body}
                    viewer={resolveViewer({ name: props.file.name, content: value().body })}
                  />
                }
              >
                <Show
                  when={value().html}
                  fallback={
                    <pre class="remote-view__text" data-remote-text>
                      {value().body}
                    </pre>
                  }
                >
                  {(html) => <pre class="remote-view__text" data-remote-text innerHTML={html()} />}
                </Show>
              </Show>
            )}
          </Match>
          <Match when={kind() === "image" && url()}>
            {(source) => <img class="remote-view__image" data-remote-image src={source()} alt={props.file.name} />}
          </Match>
          <Match when={kind() === "pdf" && url()}>
            {(source) => <iframe class="remote-view__frame" data-remote-pdf title={props.file.name} src={source()} />}
          </Match>
          <Match when={kind() && !text() && !url()}>
            <div class="remote-view__empty" data-remote-loading>
              <p>Fetching {props.file.name}…</p>
            </div>
          </Match>
        </Switch>
      </div>
    </section>
  )
}
