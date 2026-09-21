# Action Timeline port

The reference is PKU-YuanGroup/OpenAI4S at local revision `cfd297fe`:
`openai4s/server/action_timeline.py`, `frontend/src/features/timeline/{island,model,sanitize,types,ws}.ts`,
and the Action Timeline screenshot supplied for this task. The reference daemon
on port 8760 requires a browser access-token cookie; the source and screenshot
were used without changing its authentication or data.

## Mapping

| OpenAI4S behavior                    | OpenScience implementation                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Safe Action Ledger projection        | `session/action-timeline.ts` reads durable MessageV2 messages and parts; raw tool input/output, reasoning, and wire state are excluded                             |
| Ordinal history cursors              | Stable message-ID cursors; a page contains whole messages so updates to a tool never shift a page boundary                                                         |
| Action groups and execution attempts | User/model/tool/kernel/delegation/retry/compaction/snapshot records retain their persisted identities and times                                                    |
| WebSocket updates and refresh        | Existing project-scoped SSE events invalidate the view; periodic reconciliation also covers reconnects and missed updates                                          |
| Latest/before merging                | Refresh rebuilds the complete loaded window, fills bursts across multiple pages, and drops removed/reverted rows; older requests cannot update a different session |
| 46px virtual ledger and folded turns | SolidJS virtual rows with overscan, keyboard navigation, temporary search expansion, and follow-latest control                                                     |
| Timing overview                      | Measured response phases and execution intervals, bounded SVG path count, hover times, zoom/pan/time filtering and keyboard alternatives                           |
| Branch checkpoint controls           | Native research checkpoint files, full/before-message conversation forks, native file/conversation undo and restoration                                            |
| Kernel recovery controls             | Durable checkpoint recipes, per-step policy/digest/generation, isolated branch replay, partial/failed/interrupted logs and fresh retry; native fresh restart       |
| Delegation tree                      | Native child session links, parent ownership validation, exact-controller stop and guidance appended to the current loop                                           |
| Remote compute tasks                 | Native job status/target/artifact counts and cancellation through the existing credential-aware broker endpoint                                                    |
| Context composition                  | Latest provider usage and last recorded request composition estimate, cache and compaction count; reasoning is not double-counted                                  |
| Execution queue                      | Exact runtime-run cancellation and durable kernel execution timestamps/generations, including independent REPL execution history                                   |
| Sandbox/permissions                  | Actual kernel sandbox enforcement/network policy and pending/durable permission statistics                                                                         |

## Native semantic boundaries

OpenScience does not have the same Python Action Ledger or kernel-memory
checkpoint/replay protocol. The port does not import OpenAI4S's execution engine
or fabricate its queue/TTFT/recovery data. OpenScience model-message lifetimes can
include tool execution; model and tool lanes may therefore overlap. A first
response timestamp is only shown if a persisted text/reasoning part records it.
Inference without that timestamp is one undivided interval. Pending actions
without a recorded start have no estimated duration. A persisted unfinished
action in an idle session is marked interrupted.

Saved checkpoints combine native handoff documents with frozen execution recipes,
not arbitrary memory images. The replay compiler accepts independent literal
assignments and excludes calls/imports, unknown dependencies, resource-amplifying
expressions, redacted code and recorded file effects. Unknown later cells taint
earlier state; superseded generations never replay. This subset is deliberately
more conservative than OpenAI4S's AST/dependency recipe. Manual steps produce a
partial result. Each retry gets a fresh branch, with source kernel identities
mapped separately. Queue-boundary generation/execution-count checks reject
interleaved REPL work or restart. Current native execution authority is retained.
Native undo affects tracked files/conversation only and shows an affected-content
preview; replay does not roll back files. Fresh restart requires confirmation.

## API and lifecycle

- `GET /session/:sessionID/action-timeline?before=msg_...&limit=50`
- `GET /session/:sessionID/action-timeline?after=msg_...&limit=50`
- `GET /session/:sessionID/action-timeline/workbench`
- `POST /session/:sessionID/action-timeline/checkpoint`
- `POST /session/:sessionID/action-timeline/fork`
- `GET /session/:sessionID/action-timeline/revert-preview?messageID=msg_...`
- `GET|POST /session/:sessionID/action-timeline/recovery/:checkpointID`
- `POST /session/:sessionID/action-timeline/child/:childID`

`before` and `after` are mutually exclusive; `limit` is an integer from 1 to 200.
The default window contains the latest 50 messages. Every read and checkpoint
asserts session/project directory ownership. Initial loading, disconnected/stale,
empty, and partial workbench failure states are distinct. Controls are unavailable
while the session is busy, a mutation is pending, or state is unavailable.
Requests time out after 30 seconds and are aborted on unmount. Existing history
is retained after a transient failure.

The contract is generated into `tooling/sdk`. On Windows the repository generator's
final executable-script invocation may fail; running its SDK build, OpenAPI
export, and formatter with explicit `bun` is equivalent. Windows checkouts must
materialize `frontend/workspace/src/custom-elements.d.ts` as its tracked symlink.

## Verification

Backend tests use real temporary projects, storage, and Hono routes. They exercise
pagination, validation, project isolation, persisted state changes, partial/error/
cancelled outcomes, safe projection, undo filtering, and checkpoint persistence.
Frontend tests exercise request disposal, stale data, cursor progress, burst
backfill, search folding, measured geometry, token arithmetic, component
interaction and a 2,000-action virtual ledger. Existing navigation, public
contexts, and tab persistence tests are included in regression checks.

For manual acceptance, run `bun tooling/repo/timeline-preview.ts`. It creates a
separate temporary research project with 72 synthetic persisted messages,
starts a real backend on 4098 and the development workspace on 5174, and prints
the exact session URL. It never invokes a model or executes the synthetic tools.
The fixture is explicitly labelled in the UI. It does not restart an existing
application or reference daemon. Ports must be free; stop the preview when done.

The recovery integration test executes actual Python, saves a checkpoint,
recovers to a new branch and reads the restored variables while verifying the
source remains unchanged. Windows tests use the existing temporary-data-root
full-access fixture because no OS sandbox backend is available on Windows;
production security settings are unchanged. The test exposed and covers the
Windows CRLF framing fix in the Python worker. Live-provider, remote-compute and
R-interpreter acceptance still require their respective configured services.
Preview ports can be overridden with `TIMELINE_BACKEND_PORT` and
`TIMELINE_FRONTEND_PORT` to avoid existing servers.

### Local acceptance, 2026-09-21

- Backend and workspace type checks passed.
- 13 backend integration tests and 52 workspace/navigation regression tests passed (272 assertions).
- Production workspace build passed; existing JSX, RDKit externalization and chunk-size warnings remain.
- Browser acceptance covered 75-to-108 action pagination, six error matches, checkpoint persistence, recovery preview/receipt/completion and branch lineage.
- Native dark/light themes and the 375px viewport were checked; the timeline had no horizontal overflow. Theme and viewport overrides were restored afterward.
- The Python recovery test used real interpreters and verified restored values and the unchanged source generation. Provider calls, remote job execution and an R interpreter were not part of this local acceptance run.
