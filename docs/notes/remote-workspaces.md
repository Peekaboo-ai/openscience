# Projects, tasks, and remote workspaces

## Contract

The workspace opens directly into the conversation shell. Projects contain their
own conversations; Tasks contains conversations in a dedicated managed project.
Existing projects and conversations keep their identities and files.

A remote project is a bookmark owned by the local control plane, with a transport
(SSH, WSL, or an existing Docker container), remote canonical folder, and remote
project ID. The folder is not its identity. Disconnected bookmarks remain visible,
but their conversations and tools are unavailable until the remote backend
handshake succeeds. Requests never fall back to the local backend.

Connection follows choose method → settings → connect/deploy/handshake → choose
directory. Cancellation disposes the connection attempt and rejects late results.
The local process transports HTTP streams and WebSockets over the owned stdio
channel; the complete OpenScience backend runs remotely. Model settings belong to
that backend. Local credentials are not implicitly copied to a remote host.

Deployment uses a matching locally packaged native executable, a content-addressed
directory under the remote home, SHA-256 verification, and atomic publication.
SSH reuses the tested, pinned host configurations and does not forward the SSH
agent. WSL uses a selected installed distribution; Docker uses a selected running
container. Neither creates containers nor installs OS packages.

## ZCode source audit

Reference: zai-org/ZCode, commit 872ad96 (Apache-2.0).

- `packages/ui/src/WorkspaceSidebar/WorkspacePurposeSection.tsx`: Projects/Tasks
  grouping, expand/collapse, and contextual add actions.
- `packages/ui/src/RemoteConnectionDialogContent.tsx` and
  `RemoteConnectionWizardChrome.tsx`: progressive connection wizard.
- `packages/server/src/remote/connect.ts`: detect, deploy, launch, handshake,
  service binding, cancellation and disconnect ownership.
- `packages/server/src/remote/ssh-backend.ts`, `wsl-backend.ts`,
  `docker-backend.ts`: platform transports and disposal.
- `packages/desktop/src/host/windowRemoteConnectionRegistry.ts`: connection state,
  generations and separation of transport ownership from workspace identity.
- `packages/shared/src/remote-workspace-identity.ts`: authority-aware identity,
  distinct from filesystem paths.

OpenScience retains its SolidJS UI, theme tokens, HTTP contracts, native tool
authorization and project filesystem grants. It does not import ZCode's React,
RPC or agent runtime. The transport adapter preserves HTTP/SSE/WebSocket behavior
so files, terminals, compute, timelines and chat share one remote authority.

## Acceptance

Verify local task/project separation and unchanged historical project URLs;
all three wizard methods; invalid settings and unsupported runtime artifacts;
cancel/retry and transport closure; directory validation; concurrent requests,
SSE, binary responses and WebSockets; distinct remote/local paths; no fallback
after disconnect; keyboard access, narrow layout, light/dark themes.

## Verification record (2026-09-21)

- Real SCNet SSH deployment and handshake passed on Linux x64, with a
  content-addressed packaged runtime. Reconnected to the same durable project
  and session from a second local control plane.
- Verified the selected remote folder equals both filesystem `toolDirectory`
  and PTY `cwd`; terminal WebSocket delivered `uname -s` and `pwd` output.
  Host-mode execution was explicitly authorized for the dedicated test project;
  its original `approve` mode and enabled sandbox were restored afterward.
- SCNet lacks an available bubblewrap sandbox on the tested node. The connection
  remains usable for browsing; default execution is correctly denied until the
  user explicitly chooses a suitable project policy.
- WSL Ubuntu-18.04 deployment, native backend handshake, health, and home-folder
  browsing passed. `--exec` avoids a second shell interpreting nested quotes;
  mixed UTF-16 WSL diagnostics and UTF-8 Linux errors are decoded separately.
- No running Docker container was available for an actual Docker deployment.
  macOS/ARM64 transports require their corresponding packaged runtime and have
  not been exercised on this Windows host.
- Automated worker tests cover separate task/project storage, idempotent folder
  opening, no offline fallback, cancellation, concurrent requests, binary/range
  responses, SSE cancellation and connection teardown.
- Final targeted runs passed: 31 frontend tests (130 assertions) and 5 remote
  backend tests (35 assertions). Frontend/backend typechecks and production
  Windows/Linux builds passed. The reconnect fixture now keeps status snapshots
  consistent with emitted events during the initial connection refresh.
- Browser acceptance covered desktop and narrow mobile navigation, focus
  containment and Escape, light/dark themes, SSH/WSL/Docker wizard states,
  cancellation, retry, and hiding conversations after disconnect.
- Installed `2.0.127-workspaces.20260921.3` separately on port 4105 with fresh
  local data. The packaged Windows server located its adjacent Linux runtime,
  connected to Ubuntu-18.04, and opened a dedicated `/tmp` test directory on
  the remote backend. The existing port 4104 instance was left running.

Run `bun --conditions=browser tooling/repo/verify-workspace-transport.ts
'{"kind":"wsl","distro":"Ubuntu-18.04"}'` for a real transport smoke test.
`tooling/repo/verify-remote.ts` verifies an existing remote session's terminal;
it never changes execution policy. Both scripts require explicit test targets.

## Environment compatibility follow-up (2026-09-22)

SCNet's host installations were healthy: `conda env list` and Slurm worked over
ordinary SSH. The namespace exposed custom `bin` directories without their
adjacent standard/shared libraries. Runtime discovery now recognizes installation
metadata, real directory aliases, sibling libraries and Conda registration markers;
it does not bind the whole home or all other Conda environments.

The native PTY library merges inherited environment variables. Terminals now clear
excluded values at that boundary and use a clean POSIX exec environment, preventing
inherited audit prompt hooks and credential variables from reappearing. Linux
sandbox terminals use util-linux `script` to own a private controlling PTY;
`--new-session` remains enabled. Resize notifications reach only bridge processes
in that terminal's own descendant tree. Missing `script` and sandbox probe errors
produce actionable diagnostics instead of silently disabling isolation.

`compute_job({action:"environment"})` and `/workspace/environment` share bounded,
fixed read-only probes for Slurm/PBS/LSF/SGE and NVIDIA/AMD clients. Automatic host
execution admits administrator-owned programs and runtime search paths only, never
arbitrary command arguments or user-writable interpreters/libraries. Discovery is
independent of project shell network access; each client reports its own availability,
dependency, access or timeout status. CPU quotas and cgroup v1/v2 memory limits
are considered; node capacity is explicitly distinguished from cluster allocation.
The Compute panel loads these details on expansion and retains visible telemetry
during polling or query failures.

Real verification passed on SCNet with Approve mode and the sandbox enabled:
Slurm partitions and the current user's queue; complete registered Conda environment
listing; `libslurmfull.so` resolution; controlling TTY; 36×100 terminal resize; and
Ctrl-C interrupting a foreground test process. Each test PTY was removed afterward.
WSL Ubuntu-18.04 also returned a valid standalone-host inventory with no scheduler
clients. No research jobs were submitted and no execution policy was changed.

Final targeted runs passed: 15 backend environment/terminal/remote tests, 2
compute-tool contract tests and 12 frontend tests. Backend/frontend typechecks,
Windows/Linux production builds and the packaged Windows health, embedded UI and
standalone resource inventory checks passed. The installed staging binaries match
the final build SHA-256 hashes. Browser acceptance confirmed actual Slurm partition
output and preservation of expanded details during refresh.

Version `2.0.127-workspaces.20260921.4` was applied to port 4105 after the user
explicitly authorized the restart. The launcher now selects `.4`; its previous
version and the `.3` binaries remain available for rollback. WSL and SCNet were
reconnected and both remote backends reported `.4`. SCNet's resource endpoint
returned `zz-login01`, 128 logical/4 available CPU cores and working Slurm partition
and queue queries. The initial SSH attempt timed out; a retry connected and deployed
the runtime successfully. Earlier terminal verification used separate local data
and dedicated remote test projects; deployment preserved existing data and policy.

A broader compute dispatch suite cannot pass on this Windows host's missing OS
sandbox (16 execution-authority failures); this is not a full-suite green claim.
GPU hardware and native PBS/LSF/SGE clusters remain untested; SCNet's `pbsnodes`
is a Slurm compatibility client. Tools outside PATH need environment configuration,
and unsupported hardware is reported as unknown rather than absent.

## Terminal activation, effort and directory follow-up (2026-09-22)

The previous verification covered Conda listing and shared-library resolution,
not environment activation or native scheduler commands inside the terminal.
Those additional paths are now exercised by `verify-host-environment.ts`, whose
optional fourth argument names an existing Conda environment to activate.

Each terminal loads an installation-provided Conda shell hook through a private
startup file. Registered environments' runtime subtrees are exposed read-only;
user profiles, broad home mounts and package write access are not added. A Linux
terminal with scheduler clients receives private status wrappers backed by a
0700 Unix-socket directory. The host accepts only bounded, validated read-only
arguments through the existing administrator-owned executable checks. Terminal
exit cancels outstanding queries and removes the socket and startup files.

On SCNet `zz-login01`, the dedicated test project passed with Approve mode and
sandbox enabled: controlling TTY, 36×100 resize, `conda env list`, native `sinfo`
output, `squeue --me`, `conda activate bio_test`, the environment's Python prefix,
`conda deactivate`, and Ctrl-C. No job or policy changes were needed. Separately,
`zz-login02` failed even a minimal Bubblewrap probe over ordinary SSH: the child
was in uninterruptible kernel wait (`prealloc_shrinker`). This is a host-node
failure; detection remains closed and retries at most once per backend connection
to avoid accumulating stalled probes. Application code cannot repair that kernel.

Custom model effort handling reuses OpenScience's original composer popover,
per-model persistence and provider serialization. The audit also examined ZCode's
`apps/zcode-cli/packages/bootstrap/src/app/provider-registry-selection.ts` for
validation against the selected model's option specification. No implementation
was copied. Exact reviewed IDs or catalog metadata provide the effort ladder;
unknown aliases receive none. A wire test verifies `reasoning_effort` on the
OpenAI-compatible endpoint without Responses-only fields. Browser acceptance
confirmed Terra's Max persists on reload and Astra exposes its own five levels.

Directory selection is optional. The backend captures its startup directory,
validates a single project folder name, and creates or reopens that child folder.
Explicit directories must already exist. The browser can create a child folder,
reports collisions inline and previews the default path when selection is cleared.
A real SCNet browser flow created a folder and opened a project with the directory
field left blank, retaining the existing typography, buttons and form styling.

Targeted regression checks: 30 backend tests, 8 frontend tests, and
backend/frontend typechecks passed. These are targeted checks,
not a claim that the complete Windows execution suite passes.

Final navigation testing exposed an additional stream-cancellation crash in the
local remote gateway. A real Bun HTTP gateway test reproduced the unhandled
rejection before the fix and passed afterward: cancelling the browser's event
request now closes its stream normally, cancels remote work and leaves health
requests working. Actual transport disconnects still reject active readers.

Version `2.0.127-workspaces.20260922.2` is installed on port 4105. The embedded
frontend, local backend, WSL backend and SCNet backend report the same version.
The launcher and previous `.20260921.4` runtime are retained for rollback;
the launcher backup is `Start-OpenScience.pre-terminal-activation-fix.ps1`.
Installed Windows/Linux binaries match the build SHA-256 hashes. The packaged
gateway survived actual event-stream cancellation and subsequent health requests.
The installed remote composer shows Terra's Off/Low/Medium/High/Extra high/Max
options without resaving the existing provider connection.

Final SCNet reconnections were repeatedly assigned to `zz-login02`. Its resource
queries work, but the final packaged PTY check is blocked by the same Bubblewrap
timeout. No sandbox bypass was used. The successful full terminal acceptance above
was on `zz-login01`; terminal code is unchanged in the final package. A healthy
login-node assignment or administrator repair is still required for the current
SCNet connection. The standalone WSL inventory correctly reports absent scheduler
clients. Temporary preview servers and the agent's browser tab were closed.
