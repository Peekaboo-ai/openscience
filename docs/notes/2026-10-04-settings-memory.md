# Settings Memory

Memory adds explicit, persistent user notes to subsequent research requests. It follows the scope and preview behavior of OpenAI4S and the category/auto-recall interactions shown in the Claude Science reference. The implementation is original TypeScript/SolidJS; no upstream source was copied.

## Behavior and storage

- Settings → Memory uses the existing panel registry, shared form controls, typography, theme tokens, and responsive modal frame.
- Notes have a title, content, category, scope, enabled state, and optional expiration. Categories have a name, description, and auto-recall switch. Notes are saved explicitly; the model does not autonomously write them.
- Global scope is per server. Project notes apply to that project's sessions; session notes also reach descendants through the same project's parent chain. Siblings and other projects are excluded.
- Within one category, a normalized title identifies an override. The most specific active, unexpired note wins. Unrelated titles continue to coexist.
- `memory.json` lives in `Global.Path.data`. Atomic JSON writes, file leases, store revisions, validation, and explicit deletion protect durable state. Deleted-project notes remain manageable under All saved memories.
- The settings page preserves drafts after failed saves, keeps an editor's original revision across refreshes, and ignores late writes after switching away and back to the same server. Clear operations exclude inherited notes unless the user explicitly browses all saved notes.
- Project choices come from the workspace sidebar catalog, combining active local projects and configured remote connections with distinct remote keys. Memory resolves its own API destination without switching the active conversation. Disconnected connections remain selectable with background reconnect controls; global and all-note scopes offer a store selector. Connection epochs restart reads after cleanup and reject late responses. Notes in archived or removed projects remain manageable through All saved memories on their original server.

## Context path

`session/prompt.ts` calls `Memory.system(projectID, sessionID)` beside the existing instruction assembly, before provider context preflight. Changes therefore apply on a subsequent actual model request, survive conversation compaction, and count toward input budgeting. Title generation and other unrelated helper requests do not receive memory implicitly.

Recall includes at most 20 complete notes and 12,000 characters including its wrapper. Larger collections omit entire notes with visible reasons; a replacement omitted for budget does not revive the older preference it replaced. JSON encoding preserves arbitrary content as note data. The wrapper keeps current requests and existing instruction/permission rules authoritative.

The preview endpoint uses the same selector and renderer. Corrupt storage produces a visible settings error and is preserved. Research requests log the recall failure and continue without saved memory.

## Validation

- 14 backend tests: persistence, actual ownership, inherited session context, isolation, overrides, switches, expiry, budgets, concurrent updates, corruption, HTTP validation, mounted OpenAPI metadata, and actual provider-bound prompt content across save/edit/pause.
- 24 frontend/settings tests: real HTTP backend and file storage for CRUD and category controls; inherited-note deletion protection; draft conflict recovery even after refresh; server switching and delayed-save isolation; registry, retained panel state, shared labels, and existing deletion contracts.
- Frontend and backend type checks passed. Workspace production build and Linux baseline headless build passed. Generated SDK and published OpenAPI include Memory.
- Browser review covered dark/light themes, note editing, exact context preview, and widths of 1600, 768, and 390 pixels. No page errors or horizontal overflow. The writable browser review used an isolated store, not the user's notes.
- Read-only checks on actual Local and Bio settings confirmed backend routing and successful previews. Both actual stores remained empty at deployment.
- Workspace selection follow-up: 22 frontend checks passed, including eight Memory component tests using two isolated HTTP servers for remote saves, offline connection, duplicate project IDs, and delayed catalog isolation. Live read-only browser checks showed only Tasks, Bio and Bio1, loaded Bio's 15 sessions, retained the active conversation, restored the initial remote session selection, and covered light/dark appearance and a 390-pixel layout. Type checking and the workspace production build passed.

## Deployment

The local backend on port 4106 was updated; Vite on port 3000 served the updated UI. Bio was reconnected to `0.0.0-dev-202610031652` (SHA-256 `9c795c961506d1eb2e4237c839725e352ae04f781bc04b7bf7b2ab77faabb50f`). No research tasks were active during deployment. One Bio terminal was ended under the user's existing restart authorization. Bio1 remains disconnected.

Browser screenshots and deployment scripts are under `E:/Sugon/OneZone/.cache/memory-browser-review` and `.cache/deploy-memory.ts`; they are not shipped application assets.

## Editing/navigation audit

The disabled-category report came from a shared `locked` condition that included
the mere existence of an editor. Opening New memory disabled every category,
scope, project and server selector for the full lifetime of the form. This was
not a pointer overlay or a server permission error.

Browsing is now independent of editor visibility. An untouched form closes on
navigation; a changed form suspends with Resume editing and Discard draft actions.
The controller owns the full draft, so a form remount or same-server reconnect
does not lose title, content, category, scope, enabled state, expiration or the
original store revision. A bounded cache isolates drafts by backend. Browsing a
different project never silently changes a draft's save destination. Replacing
an unfinished editor requires an explicit keep/discard choice; each replacement
has a new render identity so an old category or note ID cannot be reused.

The audit also reproduced Session-to-Global/Project save failures: Solid store
object merging retained fields belonging to the old strict scope union. Scope
replacement now removes those fields. Store reads and write responses respect
monotonic revisions, and late responses from old connection epochs cannot close
or update another editor. Unknown/deleted category choices remain explicit.

Verification uses isolated real HTTP stores for category navigation, complete
draft restoration, failed-save recovery, strict scope validation, replacement
editor identity, remote reconnection and cross-server isolation. Additional
state tests exercise out-of-order reads/writes and retained original revisions.
No backend contract or storage format changed; the running frontend dev server
receives these changes without restarting local or remote research services.

The follow-up passed 27 component/state/registry tests (337 assertions), frontend
type checking and the production build. Isolated Edge browser testing used two
real fixture stores: mouse and keyboard category navigation, full field recovery,
local/remote isolation, replacement confirmations, strict Session-to-Global
payload validation, delayed failed-save recovery and successful retry all passed.
There were zero browser page errors and no horizontal overflow at 768px or 390px.
Screenshots and results are in the parent workspace's
`.cache/memory-navigation-review`; no user memory records were used for writes.
