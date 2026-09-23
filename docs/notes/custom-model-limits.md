# Custom model limits and save refresh

The old custom connection editor assigned one 32,768-context / 8,192-output pair
to every selected model and discarded capability fields returned by `/models`.
The reported 23,951-token request therefore exceeded its 22,118-token safe budget
even though the selected GPT-5.6 Terra has a substantially larger reviewed window.

`CustomModelLimits` resolves each model independently. Valid endpoint fields take
precedence; absent fields use exact IDs from the reviewed roster or provider
catalog. Unknown IDs have an explicitly unverified 128,000 / 32,000 fallback.
The resolver does not guess private aliases. Catalog indexing is cached by the
catalog object's identity, so a large model selection does not repeatedly scan it.

Selections store context, output and optional input limits in each `models[id].limit`.
Automatic/manual provenance lives in `options.customModelLimits`. An old connection
with exactly the former defaults is resolved dynamically; other explicit values
remain manual. New manual overrides of those same numbers remain manual as well.
API keys remain in the separate auth store and are not part of returned metadata.

The runtime provider merge now preserves `limit.input`, including ordinary configured
providers. `session/prompt.ts` and `session/compaction.ts` are unchanged from
`origin/main`: full-input preflight, output headroom, tool pruning, history summaries,
bounded recovery and the compaction circuit breaker remain in force. The limits
editor describes capacity, while the normal agent output cap still applies.

Saving retains the editor, selection and expanded limits. The response updates the
local connection list; controls are released after persistence without awaiting the
provider refresh. Refresh errors explicitly distinguish saved changes from a stale
picker. A 50 ms refresh window merges the configuration event and save callback;
changes during a request trigger a trailing read, with revisions rejecting stale
responses. Live project instances continue to be preserved by metadata-only configuration
writes. A new or changed key still runs the original credential revocation lifecycle;
the resulting runtime re-bootstrap keeps already loaded session content visible while
refreshing it, rather than resetting the page to its initial loading screen.

Validation on Windows:

- Backend and workspace type checks passed; SDK and OpenAPI contracts regenerated.
- Model resolver / connection tests cover metadata, exact matching, legacy migration,
  manual values, separate input caps, runtime budgets, real fixture completions and
  preservation of live project state.
- Frontend tests cover independent limits, reset, key replacement, retained editor
  identity/focus, background refresh errors and refresh races.
- The 81 preflight / compaction tests passed. Their existing shared
  teardown still reports Windows `EBUSY` removing the temporary data directory; the
  suite exit is therefore not clean. No compression test or production compression
  implementation was changed to suppress this cleanup error.
- An isolated browser preview exercised actual discovery and save with a local
  fixture: Terra used catalog limits, Sol used endpoint-specific smaller limits,
  and an unknown ID displayed the unverified fallback. The expanded editor and
  scroll position remained intact after saving; the picker reported all 3 models.

The browser fixture made no inference requests and used no user API credentials.

Installed build: `2.0.127-workspaces.20260922.4`, served on `http://127.0.0.1:4105`.
The local server, embedded UI, SCNet backend and WSL backend all report that version.
SCNet's existing Terra and Sol entries were read back as 1,050,000 context,
128,000 output and 922,000 input tokens without rewriting their credentials or
resaving the connection. The launcher backup is
`E:/Sugon/OpenScience-Workspaces/Start-OpenScience.pre-model-limits-fix.ps1`.
