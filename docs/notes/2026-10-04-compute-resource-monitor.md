# Compute resource monitor verification

The Compute inspector now combines its existing runtime/job inventory with a
node resource monitor. The monitor uses the project-scoped
`GET /settings/compute/monitor` endpoint, and the generated SDK/OpenAPI contract
includes the normalized response.

## Behavior and boundaries

- Automatic selection follows running, then queued jobs in the current session,
  then project allocations, then the connected host. Explicit selections remain
  pinned. Multi-node jobs expose the scheduler's allocated nodes.
- Slurm/PBS allocations are revalidated against the connected user's queue before
  sampling. Slurm can fall back from SSH to a bounded overlapping step in an
  existing allocation. No new compute allocation is submitted.
- CPU and memory work on standalone hosts without Python or a scheduler. Device
  adapters normalize NVIDIA CSV, Hygon JSON/legacy tables, ROCm JSON and official
  TPU runtime/HBM tables. Missing fields remain null, rather than becoming zero.
- CPU/system memory describe whole-node usage, including other workloads;
  accelerator metrics use a separately verified allocation scope. Shell-submitted
  jobs are matched against authorized project/session working directories;
  shared project directories do not imply ownership by a particular session.
- Five-second sequential sampling, bounded caches, request coalescing and client
  cancellation prevent overlapping refreshes. The open Compute tab continues
  sampling while hidden; pausing or closing that tab stops it. Target/node
  histories remain separate and retain at most 15 minutes.
- Initial sidebar clicks survive lazy project loading. Fullscreen/mobile panels
  now use both viewport edges to avoid clipping caused by scrollbar gutters.

## Verification

- Backend: 19 passing tests across telemetry normalization, the real Hono route,
  environment discovery and query argument validation.
- Python: 7 passing tests cover allocation ownership, pending/finished jobs,
  node validation, existing-allocation Slurm fallback and isolated client errors.
- Frontend: 44 passing tests across monitoring/history, inspector lifecycle,
  context activation, layout and existing style contracts.
- Backend/frontend type checks, the workspace production build and the Linux
  x64 baseline backend build passed. Production build retains existing large
  chunk warnings.
- An isolated Edge browser context exercised the real workspace with only the
  monitoring endpoint replaced by an eight-DCU fixture: ten cards, eighteen
  curves, light/dark appearance, 375px viewport, unavailable readings retaining
  history, and pause with no subsequent requests. No browser errors occurred.
- Separate browser contexts then used the deployed endpoints without fixtures.
  Both the local Windows host and the connected Linux workspace returned two
  distinct live samples and rendered CPU/memory charts without browser errors.

## Initial deployment and hardware coverage

The local backend was restarted on its existing port and the connected Bio
workspace was upgraded and reconnected. The frontend dev service kept its
existing process. The Linux runtime was uploaded into a content-addressed path,
verified with SHA-256 and its version checked before activation. The prior local
packaged runtime was retained for rollback.

Deployed Linux runtime: `0.0.0-dev-202610031550`.

SHA-256: `1a8618c47c548e7df7dd7a7201d9e0587a1a72c828c435dbdb24714df42eeeda`.

There were no active scheduler allocations during live verification. The remote
monitor correctly reported the login host, with no visible accelerators. Actual
DCU compute-node sampling, AMD hardware and TPU runtime sampling had not yet
been verified against live hardware at that point. Their parsers and
allocation/error paths were verified with fixtures. Node access still depends
on installed administrator-owned clients, trusted SSH host keys and scheduler
policy; unsupported managed providers report telemetry as unavailable.

## Windows NVIDIA and target selection follow-up

The Windows host reproduced `Failed to initialize NVML: Unknown Error` only in
the monitor's restricted environment. The identical native query succeeded;
restoring `ProgramFiles` or `ProgramW6432` also made the restricted query succeed.
The monitor now preserves the four Windows installation-directory variables
without inheriting credentials or execution hooks, and includes System32 itself
in its trusted PATH. Failed probes retain a redacted, bounded diagnostic message
or their exit code instead of only the word `error`.

Polling also recreated target option elements because each JSON response supplied
new objects. The native select displayed its first option even while the monitor
continued requesting the manually selected target. Stable option elements and
explicit selection bindings now preserve target/node choices during refresh and
inventory reordering.

Regression coverage includes the Windows runtime environment, native failure
diagnostics, a hardware-conditional comparison with real `nvidia-smi`, and rendered
component tests for the first selection response, repeated refreshes, returning
to Automatic, and reordered targets/nodes. On this host, NVIDIA GeForce RTX 4060
Laptop GPU telemetry was verified against the installed 591.59 driver (8188 MiB
VRAM); CPU, memory, and non-NVIDIA parsing tests remain covered.

The follow-up passed 22 backend and 13 frontend targeted tests, both type checks,
and the workspace production build. After updating the local backend, an isolated
Edge context received 11 successful monitor responses with four distinct live
samples. It retained Peekaboo over three polling cycles and three round trips to
Automatic, rendered CPU/memory/GPU charts in both themes, and reported no page
errors. No remote backend upgrade is needed for the Windows-only runtime fix or
the client-side selection fix.

## Continuous history and allocated DCUs

The Compute tab now owns its sampler until that tab is explicitly closed.
Changing modules or collapsing the inspector hides the mounted panel without
stopping sampling. Conversation and target histories remain separate. Polling
and backend cache freshness use request start times so probe latency does not
add another complete refresh interval. Charts mark actual failures, pauses, and
browser suspension as gaps, rather than breaking every successful interval over
20 seconds.

On the cluster's older Python in the C locale, a raw non-ASCII `-c` argument
reproduced the reported UnicodeEncodeError. Both collector hops now use an ASCII
bootstrap that decodes the embedded UTF-8 source. The node's administrator-owned
`/opt/hyhal/bin` was also missing from discovery. Its `hy-smi` exposes HCU metrics
and MiB memory values, and emits malformed adjacent power fields; the parser
handles that known delimiter defect. Linux AMD/Hygon DRM metrics are preferred
when complete, providing stable PCI identities without depending on Slurm's
remapped logical device indexes. The initial implementation enumerated whole-node
devices for allocation targets; the allocation-scope correction below supersedes
that behavior. Standalone hosts retain the driver-client fallback.

Verification passed 26 backend tests, 12 Python tests, 34 frontend tests, both
type checks, the frontend production build, and the Linux backend build. Real
local browser testing continued sampling through Files and Action Timeline,
preserved the same monitor and its history, stopped requests after closing the
Compute tab, and immediately resumed on reopening. The deployed remote API and
browser then sampled the existing Slurm 884147 allocation on f13r1n02: eight
physical DCUs, including the four held-memory cards at about 1.14 GiB each.
Other cards also showed concurrent whole-node activity. Six successful browser
responses retained all 18 CPU/memory/device curves across a Files switch, with
one continuous segment per curve and no page errors. The local RTX 4060 monitor
was checked again after deployment.

Previous remote runtime: `0.0.0-dev-202610040635-compute`.
SHA-256: `7e8137c02fcaec3c3b01aa424cc9dc203ee981abf3fb0d3589a36936d8d3e17a`.
The existing scheduler job was not cancelled or replaced. Live AMD and TPU
hardware coverage remains unavailable in this environment.

## Allocation-scope correction

The eight-card report was a collector bug: `/sys/class/drm` exposes all physical
cards even when a Slurm device cgroup permits only four. On job `885245`,
`scontrol show job -dd` reported `GRES=dcu:Hygon:4(IDX:0-3)` for `f11r1n02`.
The node has eight DCUs and an unrelated ASPEED display device at `card0`;
DRM card numbers therefore cannot be treated as scheduler accelerator indexes.

The sampler now verifies the exact job cgroup, opens each physical render device
read-only, and compares the accessible device count against the scheduler's count
for that node. The existing allocation allowed renderD128–131 and denied
renderD132–135 with EPERM. Repeated live source probes returned exactly the four
PCI identities `0000:09:00.0`, `0000:36:00.0`, `0000:55:00.0`, `0000:77:00.0`;
the other four cards were excluded. Neither busy-card heuristics nor first-N
truncation is used. No scheduler allocation was submitted or cancelled for testing.

SSH sampling requires the requested job context; otherwise a bounded overlapping
step runs inside the existing allocation. Array task IDs map through verified
Slurm detail records to their numeric cgroup ID. Missing permissions, device-count
mismatches, unknown GRES, wrong jobs and old collector responses cannot fall back
to host-wide cards. The TypeScript decoder and frontend independently validate
the job ID, expected count and unique device identities. CPU-only allocations
explicitly report zero devices. Device histories include the allocation identity.

CPU and system memory remain whole-node measurements, while allocated-device
metrics describe each assigned card's total activity, not per-process attribution.
The host summary reports tracked runtimes rather than claiming to count all
scheduler jobs. Reachable PBS nodes retain CPU/memory monitoring, with accelerator
allocation marked unavailable until its ownership can be verified. Standalone
NVIDIA/AMD/Hygon/TPU adapters remain available; NVIDIA/MIG, TPU and PBS allocated
device ownership is not claimed as verified by this implementation.

Regression coverage includes first/last/noncontiguous allocations, the ASPEED
offset, wrong cgroups, unrestricted device access, CPU-only jobs, arrays, multiple
nodes, SSH fallback, PBS metrics, old-backend responses and reassigned histories.

The final correction passed 27 backend tests, 31 Python tests and 50 frontend
tests, backend/frontend type checks, the workspace production build and Linux
x64 baseline runtime build. The local backend was restarted and Bio reconnected
to `0.0.0-dev-202610041504-compute-allocation`, SHA-256
`980f672392a197dbfbc6b9470dfb33310f1cb66b94a754ee14248a8f0113a0e6`.
Both the uploaded bytes and activated remote version were verified. The local
browser received 11 successful responses, four distinct samples, and stable
target switching with real RTX 4060 telemetry and no page errors.

Job 885245 reached its scheduled end before the deployment completed. Live
four-device validation therefore used the corrected source collector twice
while that job was running. After deployment its API correctly returned Finished
with no sample, and the login host returned Live with explicit host scope.
No replacement allocation was requested for UI testing.

An isolated browser then replayed the recorded real four-DCU sample (explicitly
marked as replay; only sampling timestamps advanced). It rendered four devices
and ten curves without overflow in light/dark themes or at 390px. Files switches
kept the same monitor and continued polling. A failed allocation verification
left CPU/memory continuous with their intervening successful readings, while
device curves retained the true gap. Node histories and allocation histories are
now cached separately. A completed job keeps its selected label, disabled
option and last samples across repeated refreshes, including a formerly selected
node; it never visually changes to Automatic until the user chooses it. Browser
verification reported zero page errors. Replay evidence is stored under
`.cache/compute-allocation-replay-review` in the parent workspace.
