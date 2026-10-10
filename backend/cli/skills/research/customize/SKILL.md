---
name: customize
description: Explain, design, inspect and manage OneLab specialist profiles, including their identity, instructions, skills and connectors. Follow the user's intent; selecting /customize or asking what it can do does not request creation.
category: research
role: workflow
allowed-tools: specialist
license: Apache-2.0
author: Anthropic
metadata:
  upstream: AcademicForge
  upstream-url: https://github.com/HughYau/AcademicForge/tree/site-first/skills/claude-science/customize
  upstream-path: skills/claude-science/customize/SKILL.md
  upstream-license: Apache-2.0
  upstream-relationship: adapted and rewritten
  skill-author: Anthropic
  adapted-by: Synthetic Sciences
---

# Customize OneLab specialists

Help with the user's actual question about reusable specialists. This skill
supports both conversation and actions. Selecting `/customize` loads the
capability; it does **not** mean "create an expert now". Use OneLab's real
`specialist` tool when needed, not `host.agents`, `host.skills`, a Python control
plane, or invented APIs.

## First match the user's intent

- **Capability questions / introduction** — e.g. `/customize`, "你能为我做些什么",
  "你能帮我做些什么", "What can you do?", "How does this work?": answer directly
  in the user's language. Briefly explain that you can help design a specialist,
  define its instructions and skills/connectors, inspect or edit existing
  specialists, and enable/disable or restore them. Give one or two example
  requests and mention Settings → Specialists. Then stop. No tools, registry
  scans, creation questionnaire, planning, research task, or new profile.
- **Inspect / compare** — read only the profiles or capabilities needed to
  answer. Describe what exists; do not create an expert to fill a perceived gap.
- **Discuss / draft / suggest** — help design a profile in the conversation.
  A draft or suggested role is not permission to save. Do not pick an unrelated
  research role on the user's behalf or treat your own proposal as consent.
  Start with a concise role, responsibilities and output format; expand into
  detailed operating instructions only when the user needs that level of detail.
- **Create / edit / enable / disable / delete / restore** — enter the relevant
  workflow only when the user has requested that action. Use explicit intent
  already supplied in this conversation; do not repeatedly ask for approval.
  If they ask to create an expert without giving its purpose, ask one focused
  question about its role and typical task before reading catalogs or drafting.

Do not convert a general consultation into a creation task because the session
title, earlier assistant text, or this skill mentions creating specialists.
An explanation should be a short answer, not an autonomous multi-step workflow.

## Discover only what the action needs

For an authorized creation, use `specialist({action: "list", query: "..."})`
to check related profiles and obtain the revision. For an edit, use
`specialist({action: "get", name: "<existing-id>"})` to obtain the complete
current profile and revision. List entries are summaries, not editable profiles.

Use existing requirements for the intended field, inputs, deliverables and
boundaries. Keep `skillNames` and `connectors` as `null` (all permitted
capabilities) unless the user asks to curate them. In that default case,
**do not call catalog**. When specific capabilities need selection or checking,
use `specialist({action: "catalog", kind: "skill", query: "scanpy", limit: 5})`
or `kind: "connector"` with a relevant name. Returned descriptions are previews;
use exact returned names, never assume that a mentioned skill is installed.

List/catalog return `items`, `total` and `nextOffset`. Fetch another page only
if the current task needs more matches. Never scan all pages just to get started.
Prefer composing relevant existing capabilities over duplicating procedures.

## Draft a coherent profile

The complete `profile` shape is:

```json
{
  "name": "single-cell-reviewer",
  "displayName": "Single-cell reviewer",
  "description": "Review single-cell study design, quality control and biological interpretation.",
  "instructions": "You specialize in single-cell study review. Identify the unit of replication, batch effects, QC exclusions and uncertainty. Request missing study metadata before making unsupported biological claims. Return findings linked to their evidence and actionable next steps.",
  "icon": "flask",
  "color": "green",
  "enabled": true,
  "skillNames": null,
  "connectors": null
}
```

- `name` is an immutable, unique lowercase identifier, at most 64 characters;
  start with a letter and use letters, numbers, hyphens or underscores.
- `displayName` is the user's label, including non-English names if appropriate.
- `description` explains when the lead should delegate to this expert.
- `instructions` supplement OneLab's specialist base prompt. State the field,
  evidence standards, output expectations and limits; do not repeat tool policy
  or override user permissions. These workers return findings to the lead.
- Icons: `brain`, `flask`, `atom`, `code`, `chart`, `book`, `search`, `sparkles`.
- Colors: `neutral`, `blue`, `purple`, `green`, `orange`, `pink`.
- `skillNames: null` and `connectors: null` mean the full live catalogs, subject
  to permissions. Explicit arrays restrict access to only those names; `[]`
  means none. Keep `null` unless the user wants curation. Never freeze the whole
  current catalog into a list: new capabilities should remain available.
- Selecting a connector does not install, connect, authenticate, or enable it.
  No credentials belong in a profile. Global/project permission denials remain
  effective, including for explicitly selected skills.

## Save and verify

Only when the user has requested creation and supplied enough information, show a
concise description of the profile and save it with `action: "create"`, the
observed `revision`, and the complete `profile`. If a material role or capability
choice remains unclear, ask before saving. Do not invent an approval requirement
for every routine edit the user already requested.

For edits, read the existing profile with `get` and preserve fields the user did not
ask to change. Use `action: "update"`, its `name`, the current `revision`, and
the complete edited `profile`. On a revision conflict read again, compare the
new state, and reapply only the intended change. Do not blindly retry an old
full-profile replacement. Use `toggle` with `enabled` for pausing/resuming.

Use `remove` only when the user requests deletion or restoring defaults. It
deletes custom profiles and restores built-in profiles. Config-file profiles
are read-only here; explain their source or create a distinct custom profile.

The write receipt contains the saved identity and capability counts. Check it;
use `get` if the edited instructions or exact capability scope need verification.
Tell the user where it appears: Settings → Specialists on this server,
and that the lead can delegate with `task({subagent_type: "<name>", ...})`.
Do not claim the expert has run successfully until a real delegated task proves
that. Do not start a research task merely to demonstrate profile creation.

## Execution boundaries

Profiles belong to the current OneLab server and are shared across its projects.
Local and remote servers maintain their own registries; never imply that a local
edit has also changed a remote profile. A specialist cannot manage the registry
or delegate more workers through this workflow. Missing skills, disconnected
connectors, permission failures and storage errors must be reported explicitly;
never substitute a fake success or write around the managed store.
