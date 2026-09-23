import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@synsci/ui/dialog"
import { Button } from "@synsci/ui/button"
import { useDialog } from "@synsci/ui/context/dialog"
import { IconCloud, IconFolder, IconTerminal, IconCpu, IconChevronLeft } from "@/atlas/shared/Icon"
import { useWorkspaces, type RemoteWorkspace, type RemoteTarget, type DirectoryListing } from "./context"
import { settingsApi } from "@/components/settings/api"
import type { Project } from "@synsci/sdk/v2/client"

type SshConfig = {
  alias: string
  hostname?: string
  port?: number
  user?: string
  identity_file?: string
  proxy_jump?: string
}
type Options = {
  hosts: { id: string; label: string; ready: boolean }[]
  configs: SshConfig[]
  wsl: string[]
  docker: string[]
}
export function ProjectDialog(props: { remote?: RemoteWorkspace; mode?: "local" | "remote" }) {
  const workspaces = useWorkspaces()
  const dialog = useDialog()
  const [state, setState] = createStore({
    mode: props.mode ?? (props.remote ? "remote" : "local"),
    step: props.remote ? 2 : 0,
    kind: props.remote?.target.kind ?? ("ssh" as RemoteTarget["kind"]),
    name: props.remote?.name ?? "",
    host: props.remote?.target.kind === "ssh" ? props.remote.target.host_id : "",
    distro: "",
    user: "",
    container: "",
    directory: props.remote?.directory ?? "",
    listing: undefined as DirectoryListing | undefined,
    options: { hosts: [], configs: [], wsl: [], docker: [] } as Options,
    connection: props.remote,
    hostname: "",
    port: "22",
    sshUser: "",
    identity: "",
    jump: "",
    busy: false,
    error: "",
    progress: "",
    loading: false,
    folderName: "",
    creatingFolder: false,
  })
  let alive = true
  const operationID = crypto.randomUUID()
  let saved = !!props.remote?.projectID
  const abort = new AbortController()
  const report = (error: unknown) => {
    if (alive) setState("error", error instanceof Error ? error.message : "Operation failed")
  }
  const request = <T,>(route: string, init?: RequestInit) => workspaces.api<T>(route, { ...init, signal: abort.signal })
  const defaultDirectory = () =>
    `${(state.listing?.workingDirectory ?? state.connection?.home ?? "").replace(/\/$/, "")}/${state.name.trim() || "project-name"}`
  async function browse(directory?: string, select = true) {
    setState({ loading: true, error: "" })
    try {
      const base =
        state.mode === "remote" && state.connection ? workspaces.remoteBase(state.connection.id) : workspaces.localUrl
      const listing = await settingsApi<DirectoryListing>(
        base,
        workspaces.fetch,
        `/workspace/directories${directory ? `?path=${encodeURIComponent(directory)}` : ""}`,
        { signal: abort.signal },
      )
      if (alive) setState({ listing, ...(select ? { directory: listing.directory } : {}) })
    } catch (error) {
      report(error)
    } finally {
      if (alive) setState("loading", false)
    }
  }
  async function newFolder() {
    if (!state.listing || !state.folderName.trim() || state.creatingFolder) return
    setState({ creatingFolder: true, error: "" })
    try {
      const base =
        state.mode === "remote" && state.connection ? workspaces.remoteBase(state.connection.id) : workspaces.localUrl
      const created = await settingsApi<{ directory: string }>(base, workspaces.fetch, "/workspace/directories", {
        method: "POST",
        body: JSON.stringify({ parent: state.listing.directory, name: state.folderName }),
        signal: abort.signal,
      })
      if (!alive) return
      setState("folderName", "")
      await browse(created.directory)
    } catch (error) {
      report(error)
    } finally {
      if (alive) setState("creatingFolder", false)
    }
  }
  async function connect() {
    if (state.busy) return
    setState({ busy: true, error: "", step: 2 })
    try {
      if (state.kind === "ssh" && !state.connection) {
        if (state.host === "new") {
          setState("progress", "Saving SSH connection…")
          const label = state.name.trim() || state.hostname.trim()
          const settings = await request<{ ssh_hosts: { id: string; label: string; host: string }[] }>(
            "/settings/compute/ssh",
            {
              method: "POST",
              body: JSON.stringify({
                label,
                host: state.hostname.trim(),
                user: state.sshUser.trim() || undefined,
                port: Number(state.port),
                identity_file: state.identity.trim() || undefined,
                proxy_jump: state.jump.trim() || undefined,
                scheduler: "none",
                concurrency: 4,
              }),
            },
          )
          const host = settings.ssh_hosts.find((item) => item.label === label && item.host === state.hostname.trim())
          if (!host) throw new Error("The saved SSH host was not returned")
          setState("host", host.id)
        }
        if (!state.options.hosts.find((host) => host.id === state.host)?.ready) {
          setState("progress", "Testing SSH identity and pinning host key…")
          const probe = await request<{ ok: boolean; error?: string }>(`/settings/compute/ssh/${state.host}/test`, {
            method: "POST",
          })
          if (!probe.ok) throw new Error(probe.error || "SSH connection test failed")
        }
      }
      const target: RemoteTarget =
        state.kind === "ssh"
          ? { kind: "ssh", host_id: state.host }
          : state.kind === "wsl"
            ? { kind: "wsl", distro: state.distro, ...(state.user ? { user: state.user } : {}) }
            : { kind: "docker", container: state.container }
      // 创建书签保留响应，关闭向导后仍可精确清理，避免取消请求留下未知 ID。
      const connection =
        state.connection ??
        (await workspaces.api<RemoteWorkspace>("/remote-workspaces", {
          method: "POST",
          body: JSON.stringify({
            name:
              state.name.trim() ||
              (state.kind === "ssh"
                ? state.options.hosts.find((host) => host.id === state.host)?.label
                : state.kind === "wsl"
                  ? state.distro
                  : state.container) ||
              "Remote project",
            target,
          }),
        }))
      if (!alive) {
        await workspaces.remove(connection.id)
        return
      }
      setState({ connection, name: state.name || connection.name })
      await request(`/remote-workspaces/${connection.id}/connect`, { method: "POST" })
      await workspaces.refresh()
    } catch (error) {
      report(error)
      setState("busy", false)
    }
  }
  async function poll() {
    if (!state.connection || state.step !== 2 || !alive) return
    try {
      const list = await request<RemoteWorkspace[]>("/remote-workspaces")
      const connection = list.find((item) => item.id === state.connection?.id)
      if (!alive || !connection) return
      setState({ connection, progress: connection.progress })
      if (connection.state === "error") setState({ error: connection.error ?? "Connection failed", busy: false })
      if (connection.state === "connected") {
        setState({ step: 3, busy: false })
        await browse(connection.directory, !!connection.directory)
      }
    } catch (error) {
      report(error)
    }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (state.busy || !state.name.trim()) return
    setState({ busy: true, error: "" })
    try {
      if (state.mode === "remote") {
        if (!state.connection || state.connection.state !== "connected")
          throw new Error("Connect before opening a remote project")
        const remote = await request<RemoteWorkspace>(`/remote-workspaces/${state.connection.id}/open`, {
          method: "POST",
          body: JSON.stringify({ name: state.name, directory: state.directory.trim() || undefined }),
        })
        await workspaces.refresh()
        saved = true
        workspaces.open(remote.projectID!, undefined, remote.id)
      } else {
        const project = state.directory.trim()
          ? (
              await request<{ project: Project }>("/workspace/open", {
                method: "POST",
                body: JSON.stringify({ name: state.name, directory: state.directory }),
              })
            ).project
          : await request<Project>("/global/project", {
              method: "POST",
              body: JSON.stringify({ name: state.name, sources: [], operation_id: operationID }),
            })
        await workspaces.refresh()
        saved = true
        workspaces.open(project.id)
      }
      if (alive) dialog.close()
    } catch (error) {
      report(error)
    } finally {
      if (alive) setState("busy", false)
    }
  }
  onMount(() => {
    void request<Options>("/remote-workspaces/options")
      .then((options) => {
        if (alive)
          setState({
            options,
            host: state.host || options.hosts.find((item) => item.ready)?.id || "",
            distro: options.wsl[0] ?? "",
            container: options.docker[0] ?? "",
          })
      })
      .catch(report)
    if (props.remote) void connect()
    let polling = false
    const timer = setInterval(() => {
      if (!polling) {
        polling = true
        void poll().finally(() => {
          polling = false
        })
      }
    }, 1000)
    onCleanup(() => {
      alive = false
      abort.abort()
      clearInterval(timer)
      if (!saved && state.connection) void workspaces.remove(state.connection.id).catch(() => undefined)
      else if (state.connection?.state === "connecting")
        void workspaces.disconnect(state.connection.id).catch(() => undefined)
    })
  })
  return (
    <Dialog
      title={state.mode === "remote" ? "Remote connection" : "Add project"}
      description={
        state.mode === "remote"
          ? "Connect a workspace and run OpenScience on its host."
          : "Keep research conversations and files together."
      }
      class="workspace-project-dialog"
      fit
      transition
    >
      <form class="workspace-project-form" onSubmit={save}>
        <Show when={state.mode === "remote"}>
          <ol class="workspace-steps" aria-label="Connection progress">
            <For each={["Choose method", "Settings", "Connecting", "Choose directory"]}>
              {(label, index) => (
                <li aria-current={state.step === index() ? "step" : undefined} data-done={state.step > index()}>
                  <span>{index() + 1}</span>
                  {label}
                </li>
              )}
            </For>
          </ol>
        </Show>
        <div class="workspace-form-content">
          <Show when={state.mode === "remote" && state.step === 0}>
            <div class="workspace-methods">
              <For each={["ssh", "wsl", "docker"] as const}>
                {(kind) => (
                  <button
                    type="button"
                    class="workspace-method"
                    aria-pressed={state.kind === kind}
                    onClick={() => setState("kind", kind)}
                  >
                    {kind === "ssh" ? (
                      <IconCloud size={20} />
                    ) : kind === "wsl" ? (
                      <IconTerminal size={20} />
                    ) : (
                      <IconCpu size={20} />
                    )}
                    <strong>{kind === "ssh" ? "SSH" : kind === "wsl" ? "WSL" : "Docker"}</strong>
                    <span>
                      {kind === "ssh"
                        ? "Remote host"
                        : kind === "wsl"
                          ? "Windows Subsystem for Linux"
                          : "Running local container"}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={state.mode === "local" || state.step === 1 || state.step === 3}>
            <label class="workspace-field">
              Project name
              <input
                value={state.name}
                maxlength={100}
                required={state.mode === "local" || state.step === 3}
                onInput={(event) => setState("name", event.currentTarget.value)}
                placeholder="Research project"
              />
            </label>
          </Show>
          <Show when={state.mode === "remote" && state.step === 1}>
            <Show when={state.kind === "ssh"}>
              <label class="workspace-field">
                SSH host
                <select value={state.host} onChange={(event) => setState("host", event.currentTarget.value)}>
                  <option value="">Choose a host</option>
                  <For each={state.options.hosts}>
                    {(host) => (
                      <option value={host.id}>
                        {host.label}
                        {host.ready ? "" : " · needs connection test"}
                      </option>
                    )}
                  </For>
                  <option value="new">Add / import SSH connection…</option>
                </select>
              </label>
              <Show when={state.host === "new"}>
                <Show when={state.options.configs.length}>
                  <label class="workspace-field">
                    Import from SSH config
                    <select
                      onChange={(event) => {
                        const config = state.options.configs.find((item) => item.alias === event.currentTarget.value)
                        if (config)
                          setState({
                            hostname: config.hostname || config.alias,
                            port: String(config.port ?? 22),
                            sshUser: config.user ?? "",
                            identity: config.identity_file ?? "",
                            jump: config.proxy_jump ?? "",
                            name: state.name || config.alias,
                          })
                      }}
                    >
                      <option value="">Enter manually</option>
                      <For each={state.options.configs}>
                        {(config) => <option value={config.alias}>{config.alias}</option>}
                      </For>
                    </select>
                  </label>
                </Show>
                <label class="workspace-field">
                  Hostname
                  <input
                    value={state.hostname}
                    onInput={(event) => setState("hostname", event.currentTarget.value)}
                    placeholder="cluster.example.org"
                  />
                </label>
                <div class="workspace-path">
                  <label class="workspace-field">
                    User
                    <input value={state.sshUser} onInput={(event) => setState("sshUser", event.currentTarget.value)} />
                  </label>
                  <label class="workspace-field">
                    Port
                    <input
                      type="number"
                      min="1"
                      max="65535"
                      value={state.port}
                      onInput={(event) => setState("port", event.currentTarget.value)}
                    />
                  </label>
                </div>
                <label class="workspace-field">
                  Identity file (optional)
                  <input
                    value={state.identity}
                    onInput={(event) => setState("identity", event.currentTarget.value)}
                    placeholder="Use SSH agent, or enter a private key file path"
                  />
                </label>
                <label class="workspace-field">
                  ProxyJump (optional)
                  <input
                    value={state.jump}
                    onInput={(event) => setState("jump", event.currentTarget.value)}
                    placeholder="user@jump-host:22"
                  />
                </label>
              </Show>
              <p class="workspace-hint">
                Uses your SSH agent or selected identity file. The connection test verifies the host key before
                deployment.
              </p>
            </Show>
            <Show when={state.kind === "wsl"}>
              <label class="workspace-field">
                Distribution
                <input
                  list="workspace-wsl"
                  value={state.distro}
                  onInput={(event) => setState("distro", event.currentTarget.value)}
                  placeholder="Ubuntu"
                />
                <datalist id="workspace-wsl">
                  <For each={state.options.wsl}>{(item) => <option value={item} />}</For>
                </datalist>
              </label>
              <label class="workspace-field">
                User (optional)
                <input
                  value={state.user}
                  onInput={(event) => setState("user", event.currentTarget.value)}
                  placeholder="Default distribution user"
                />
              </label>
            </Show>
            <Show when={state.kind === "docker"}>
              <label class="workspace-field">
                Container
                <input
                  list="workspace-docker"
                  value={state.container}
                  onInput={(event) => setState("container", event.currentTarget.value)}
                  placeholder="Container name or ID"
                />
                <datalist id="workspace-docker">
                  <For each={state.options.docker}>{(item) => <option value={item} />}</For>
                </datalist>
              </label>
            </Show>
            <p class="workspace-hint">
              The matching OpenScience backend will be installed in the target user's home. Model credentials are
              configured separately on that backend.
            </p>
          </Show>
          <Show when={state.mode === "remote" && state.step === 2}>
            <div class="workspace-connecting" role="status">
              <IconCloud size={20} />
              <strong>{state.error ? "Connection needs attention" : state.progress || "Preparing connection…"}</strong>
              <p>Only a connected backend can load remote conversations.</p>
            </div>
          </Show>
          <Show when={state.mode === "local" || state.step === 3}>
            <div class="workspace-field">
              <label for="workspace-working-directory">
                {state.mode === "remote" ? "Remote working directory (optional)" : "Working directory (optional)"}
              </label>
              <div class="workspace-path">
                <input
                  id="workspace-working-directory"
                  value={state.directory}
                  onInput={(event) => setState("directory", event.currentTarget.value)}
                  placeholder={
                    state.mode === "remote" ? defaultDirectory() : "Use a managed project, or choose a folder"
                  }
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={state.loading}
                  onClick={() => void browse(state.directory || undefined)}
                >
                  Browse
                </Button>
              </div>
            </div>
            <Show when={state.mode === "remote"}>
              <p class="workspace-hint">
                {state.directory.trim()
                  ? "Use the selected folder, or clear the path to create a project folder automatically."
                  : `Create or open: ${defaultDirectory()}`}
              </p>
            </Show>
            <Show when={state.listing}>
              {(listing) => (
                <nav class="workspace-directories" aria-label="Choose working directory">
                  <button type="button" disabled={state.loading} onClick={() => void browse(listing().parent)}>
                    <IconChevronLeft />
                    Parent directory
                  </button>
                  <For each={listing().entries}>
                    {(entry) => (
                      <button type="button" disabled={state.loading} onClick={() => void browse(entry.path)}>
                        <IconFolder />
                        <span>{entry.name}</span>
                      </button>
                    )}
                  </For>
                  <Show when={!listing().entries.length}>
                    <p>No subdirectories. You can open this folder.</p>
                  </Show>
                </nav>
              )}
            </Show>
            <Show when={state.listing}>
              <div class="workspace-field">
                <label for="workspace-new-folder">New folder in {state.listing?.directory}</label>
                <div class="workspace-path">
                  <input
                    id="workspace-new-folder"
                    maxlength={100}
                    placeholder="Folder name"
                    value={state.folderName}
                    onInput={(event) => setState("folderName", event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        void newFolder()
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={state.creatingFolder || state.loading || !state.folderName.trim()}
                    onClick={() => void newFolder()}
                  >
                    {state.creatingFolder ? "Creating…" : "Create folder"}
                  </Button>
                </div>
              </div>
            </Show>
          </Show>
          <Show when={state.error}>
            <p class="workspace-error" role="alert">
              {state.error}
            </p>
          </Show>
        </div>
        <footer class="workspace-form-footer">
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            {state.busy ? "Cancel connection" : "Cancel"}
          </Button>
          <Show
            when={!props.remote && state.mode === "remote" && (state.step === 1 || (state.step === 2 && !!state.error))}
          >
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                if (state.step === 1) {
                  setState("step", 0)
                  return
                }
                if (state.connection && !props.remote) {
                  void workspaces.remove(state.connection.id).catch(report)
                  setState("connection", undefined)
                }
                setState({ step: 1, error: "" })
              }}
            >
              Back
            </Button>
          </Show>
          <Show when={state.mode === "remote" && state.step === 0}>
            <Button type="button" onClick={() => setState("step", 1)}>
              Next
            </Button>
          </Show>
          <Show when={state.mode === "remote" && (state.step === 1 || (state.step === 2 && !!state.error))}>
            <Button
              type="button"
              disabled={
                state.busy ||
                (state.kind === "ssh" ? !state.host : state.kind === "wsl" ? !state.distro : !state.container)
              }
              onClick={() => void connect()}
            >
              {state.error ? "Retry" : "Connect"}
            </Button>
          </Show>
          <Show when={state.mode === "local" || state.step === 3}>
            <Button type="submit" disabled={state.busy || state.creatingFolder || !state.name.trim()}>
              {state.busy ? "Opening…" : "Open project"}
            </Button>
          </Show>
        </footer>
      </form>
    </Dialog>
  )
}
