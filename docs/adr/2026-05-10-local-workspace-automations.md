# ADR 0001: Local Workspace Automations

Status: Proposed
Date: 2026-05-10

## Context

`codesymphony` already has strong primitives for agent execution:

- repository and worktree management
- thread-scoped agent sessions
- SSE-backed event timelines
- permission / question / plan gates
- terminal sessions and run scripts

It also already has a narrow automation feature: repository-level `saveAutomation`, which can send stdin to the active run session or workspace terminal after matching files are saved.

That existing feature is useful, but it is not the same product as Superset's `automations`.

After analyzing `superset-sh/superset`, the key finding is that their automation feature is a first-class saved execution object:

- a named prompt
- bound to an execution context
- optionally scheduled
- producing a reviewable result surface
- with run history and deep links back into the resulting workspace/session

The goal of this ADR is to define the `codesymphony` version of that feature in a way that fits this repository's local-first architecture and current UX shell.

## Grounding

This ADR is grounded in the current `superset` implementation and docs, especially:

- `../superset/plans/20260417-automations.md`
- `../superset/apps/docs/content/docs/automations.mdx`
- `../superset/packages/trpc/src/router/automation/automation.ts`
- `../superset/packages/trpc/src/router/automation/dispatch.ts`
- `../superset/apps/api/src/app/api/automations/evaluate/route.ts`
- `../superset/apps/api/src/app/api/automations/dispatch/[id]/route.ts`
- `../superset/apps/api/src/app/api/automations/run-failed/route.ts`
- `../superset/packages/db/src/schema/schema.ts`
- `../superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/page.tsx`
- `../superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/components/CreateAutomationDialog/CreateAutomationDialog.tsx`
- `../superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/$automationId/page.tsx`
- `../superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/$automationId/components/AutomationDetailSidebar/AutomationDetailSidebar.tsx`
- `../superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/automations/$automationId/components/PreviousRunsList/PreviousRunsList.tsx`
- `../superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/useConsumeAutomationRunLink/useConsumeAutomationRunLink.ts`

This ADR also reflects current `codesymphony` constraints and extension points:

- `apps/runtime/prisma/schema.prisma`
- `apps/runtime/src/index.ts`
- `apps/runtime/src/events/workspaceEventHub.ts`
- `apps/runtime/src/routes/workspaceEvents.ts`
- `apps/runtime/src/services/chat/chatService.ts`
- `apps/runtime/src/services/chat/planExecution.ts`
- `apps/runtime/src/services/terminalService.ts`
- `apps/web/src/routes/index.tsx`
- `apps/web/src/pages/WorkspacePage.tsx`
- `apps/web/src/pages/workspace/WorkspaceSidebar.tsx`
- `apps/web/src/components/workspace/SettingsDialog.tsx`
- `apps/web/src/pages/workspace/hooks/useWorkspaceFileEditor.ts`

## Superset Findings

Superset's implementation is opinionated in several ways:

- `automations` is a first-class domain, not a settings toggle.
- The main object is a saved prompt plus execution context.
- Scheduling uses RRULE plus timezone plus `nextRunAt`.
- A run is distinct from an automation definition.
- UI is split into a list page, create dialog, detail page, and previous-runs sidebar.
- Clicking a run deep-links into the resulting workspace and focuses the correct chat or terminal pane.
- Prompt version history is part of the product, not an afterthought.

Superset also makes several cloud-specific choices that we should not copy directly:

- dispatch goes through cloud API, relay, and host-service
- evaluation uses QStash / cron infrastructure
- feature is paywalled
- v1 run tracking stops at `dispatched` because the long-running agent is no longer in the same process

`codesymphony` does not have those constraints. Our runtime owns the scheduler, worktree creation, thread execution, and event stream locally. That means we can simplify dispatch and provide richer run state.

## Decision

`codesymphony` should add a new first-class product surface named `Automations`.

This must be modeled separately from repository `saveAutomation`.

The new product should be chat-first, local-first, and worktree-aware:

- chat-first because thread execution, approvals, plan review, and timeline UI are our strongest primitives
- local-first because runtime, scheduler, and agent runner live in the same process
- worktree-aware because branch isolation is core to this app's value proposition

The default execution model should be:

- reuse an existing worktree
- create a new thread for each run
- send the saved prompt as a user message into that new thread

Advanced strategies can be added later:

- new worktree per run
- reuse an existing thread
- terminal-targeted automations

`saveAutomation` remains supported, but it is explicitly not the same feature. Over time it should be repositioned in copy as a save-trigger action, not as the main automation product.

## Why Separate From `saveAutomation`

The current `saveAutomation` feature is:

- repository-scoped
- triggered only by file save
- terminal/stdin oriented
- stored inline on `Repository`
- invisible in run history
- not schedulable
- not reviewable as a first-class workflow

The new automation feature needs:

- its own CRUD lifecycle
- run history
- scheduling state
- execution targets
- deep links to outputs
- richer status tracking
- future prompt versioning and templates

Trying to extend `Repository.saveAutomation` into this product would mix two unrelated concepts and create long-term naming debt.

## Product Model

### Automation

A saved definition of recurring or manual agent work.

Recommended initial fields:

- `id`
- `repositoryId`
- `name`
- `prompt`
- `enabled`
- `worktreeStrategy`
- `targetWorktreeId`
- `threadStrategy`
- `targetThreadId`
- `agent`
- `model`
- `modelProviderId`
- `permissionMode`
- `chatMode`
- `rrule`
- `timezone`
- `dtstart`
- `nextRunAt`
- `lastRunAt`
- `createdAt`
- `updatedAt`

Recommended enums:

- `AutomationWorktreeStrategy = "reuse_worktree" | "new_worktree_per_run"`
- `AutomationThreadStrategy = "new_thread" | "reuse_thread"`

Phase 1 should only allow:

- `reuse_worktree`
- `new_thread`

The schema can still be designed to grow into the other variants without another conceptual rewrite.

### Automation Run

A single execution attempt for an automation.

Recommended initial fields:

- `id`
- `automationId`
- `repositoryId`
- `worktreeId`
- `threadId`
- `status`
- `triggerKind`
- `scheduledFor`
- `startedAt`
- `finishedAt`
- `error`
- `summary`
- `createdAt`
- `updatedAt`

Recommended enums:

- `AutomationRunStatus = "queued" | "dispatching" | "running" | "waiting_input" | "succeeded" | "failed" | "canceled" | "skipped"`
- `AutomationTriggerKind = "manual" | "schedule"`

This is intentionally richer than Superset's v1 `dispatched` model because `codesymphony` can observe thread lifecycle directly.

### Prompt Versions

Prompt versioning should exist, but it does not need to block phase 1.

Phase 3 should add:

- `AutomationPromptVersion`
- restore support
- version history sheet in the detail view

Superset proves this becomes valuable quickly once prompts become living assets.

## UX Spec

### Navigation

Add a dedicated top-level route:

- `apps/web/src/routes/automations.tsx`

Reasoning:

- automations are cross-worktree and often cross-repository
- list and history views do not fit naturally into the current right panel
- a dedicated route matches the mental model users already learn in Superset

Add entry points in:

- left sidebar footer, above `Settings`
- workspace header overflow menu, prefilled from current workspace

### List Page

The list page should be the control center.

It should show:

- name
- repository
- worktree strategy
- agent
- next run
- last run
- current status
- enabled / paused state
- quick actions for `Run now`, `Pause/Resume`, `Edit`, and `Delete`

It should support:

- filtering by repository
- filtering by enabled / paused
- sorting by next run or updated time

This should be a full page, not a modal.

### Create Flow

The create flow should open as a dialog from the list page and from the workspace header.

Initial fields:

- name
- prompt
- repository
- worktree
- agent / model
- permission mode
- schedule

Initial defaults when opened from the workspace route:

- repository = current repository
- worktree = current worktree
- agent / model = current thread selection if available, otherwise agent defaults
- permission mode = current thread permission mode if available

Initial defaults when opened from the automations route:

- repository = most recently used repository
- worktree = repository root worktree
- schedule = disabled until user chooses one

Phase 1 should keep the create flow intentionally narrow:

- only `reuse current worktree`
- only `new thread per run`
- only chat-thread execution

This avoids making the first UX too abstract.

### Detail Page

The detail page should mirror Superset's strengths while staying native to `codesymphony`.

Main body:

- editable name
- editable prompt

Right sidebar:

- status
- next run
- last run
- repository
- worktree
- agent / model
- permission mode
- schedule
- recent runs

Header actions:

- `Run now`
- `Pause/Resume`
- `Delete`
- `Version history` later

### Run History

Recent runs should be visible on the detail page.

Each row should show:

- status dot
- relative time
- short summary or error snippet
- target worktree / thread label if available

Click behavior:

- chat-targeted run opens the workspace route with `repoId`, `worktreeId`, and `threadId`
- later, terminal-targeted run can open a bottom-panel session by adding a dedicated query param for terminal session focus

### Approval and Waiting UX

This is one place where `codesymphony` should deliberately diverge from Superset.

If a scheduled run hits:

- a permission gate
- a question
- a plan awaiting review

the run should transition to `waiting_input`, and the linked thread should become the place where the user resolves that blocker.

This is safer than forcing unattended full-access execution by default.

The create flow should still allow an explicit advanced choice:

- `permissionMode = full_access`

That choice should be opt-in and clearly labeled.

## Architecture Spec

### Runtime Services

Add a dedicated runtime service:

- `apps/runtime/src/services/automationService.ts`

Responsibilities:

- CRUD for automation definitions
- validate schedule fields
- compute `nextRunAt`
- create runs
- dispatch runs
- recover due runs on runtime startup
- maintain a minute-based scheduler tick
- map thread lifecycle into run status

Do not bury this logic inside `chatService` or `repositoryService`.

`chatService` should stay the execution primitive, not the automation domain owner.

### Runtime API

Add REST endpoints under:

- `GET /api/automations`
- `POST /api/automations`
- `GET /api/automations/:id`
- `PATCH /api/automations/:id`
- `DELETE /api/automations/:id`
- `POST /api/automations/:id/run`
- `GET /api/automations/:id/runs`

Optional later:

- `GET /api/automations/:id/versions`
- `POST /api/automations/:id/versions/:versionId/restore`

Reasoning:

- the current runtime is REST-first
- the web app already has API wrappers in `apps/web/src/lib/api.ts`
- introducing a new RPC style just for automations would add unnecessary inconsistency

### Scheduler

Unlike Superset, `codesymphony` does not need cloud cron or relay infrastructure.

Recommended scheduler design:

- `setInterval` heartbeat every 30 to 60 seconds inside runtime
- on each tick, query `enabled && nextRunAt <= now`
- create one `AutomationRun` per due occurrence
- use a unique `(automationId, scheduledFor)` constraint for deduplication
- advance `nextRunAt` after successful claim, not after full run completion
- on startup, perform one immediate tick for catch-up

Accepted constraint for phase 1 and phase 2:

- if runtime is not running, schedules do not fire

This is acceptable for a local-first product and much simpler than pretending background reliability exists when it does not.

### Dispatch Flow

Recommended dispatch flow for the default strategy:

1. scheduler or `Run now` creates an `AutomationRun`
2. resolve target repository and worktree
3. create a fresh chat thread in that worktree
4. persist agent/model/provider/permission/mode selection onto the thread
5. enqueue the automation prompt as a user message
6. let existing `chatService` schedule the assistant
7. subscribe to thread events and reflect them into run state

Recommended future dispatch flow for `new_worktree_per_run`:

1. create worktree from repository default branch or automation override
2. create thread in the new worktree
3. dispatch prompt
4. deep-link the run back to that worktree and thread

### Run State Mapping

Map existing thread and event behavior into automation run states:

- run created -> `queued`
- dispatch begins -> `dispatching`
- first assistant activity or tool activity -> `running`
- pending permission / question / plan -> `waiting_input`
- `chat.completed` -> `succeeded`
- `chat.failed` -> `failed`

This should reuse existing event semantics from:

- `apps/runtime/src/services/chat/chatThreadStatus.ts`
- `apps/web/src/pages/workspace/hooks/worktreeThreadStatus.ts`

### Real-Time UI Updates

The current workspace sync stream is the simplest real-time transport to extend.

Recommended additions:

- extend workspace sync event schema with `automationId` and `automationRunId`
- add event types:
  - `automation.created`
  - `automation.updated`
  - `automation.deleted`
  - `automation.run.created`
  - `automation.run.updated`

Alternative:

- create a dedicated automation event stream

Recommendation:

- extend the existing global workspace sync stream first

The current app shell is already subscribed to a global stream, and automations are also global app state.

### Persistence

Add new Prisma models rather than encoding automations inside `Repository`.

That keeps:

- repository metadata clean
- migration intent obvious
- future run history queries straightforward

### Schedule Format

Use RRULE plus timezone, as Superset does.

Reasoning:

- better fit for presets plus advanced custom recurrence
- timezone-safe
- portable to later desktop background execution if needed

Do not store cron as the source of truth.

If cron import is desirable later, parse it into RRULE before persistence.

## Recommended Phasing

### Phase 1

Ship the first-class product without background scheduling.

Scope:

- automation CRUD
- dedicated `/automations` route
- create dialog
- detail page
- run history
- manual `Run now`
- chat-thread execution only
- `reuse_worktree + new_thread` only

Reasoning:

- validates the product model
- reuses strong existing primitives
- avoids scheduler and worktree explosion complexity

### Phase 2

Add recurring scheduling.

Scope:

- RRULE persistence
- runtime scheduler tick
- next run calculation
- pause / resume
- richer run status
- workspace sync events for live updates

### Phase 3

Add product depth.

Scope:

- `new_worktree_per_run`
- prompt version history
- templates
- create-from-current-thread shortcut
- notifications for `waiting_input`
- optional terminal-targeted runs

## Consequences

Positive consequences:

- aligns `codesymphony` with a proven workflow from Superset
- stays native to this repo's thread-first UX
- keeps the existing save-on-file-save feature intact
- avoids premature cloud-style complexity
- produces a durable execution log users can revisit

Negative consequences:

- adds a second automation concept until `saveAutomation` is renamed or reframed
- a dedicated route introduces the first major non-workspace screen in the web app
- background schedules depend on runtime uptime
- `new_worktree_per_run` can create clutter if shipped too early

## Explicit Non-Goals

Not in initial scope:

- cloud dispatch
- teammate targeting
- paid-plan gating
- webhooks
- guaranteed background execution while runtime is closed
- full prompt composer parity with attachments and slash-command discovery
- replacing repository `saveAutomation`

## Open Questions

1. Should phase 1 expose only manual automations, or should the create flow include schedule fields before the scheduler ships?
2. Should the first route be `/automations`, or should we add a more general dashboard shell first and nest the route under that?
3. When a run is `waiting_input`, should the app raise a global badge, a toast, or both?
4. Do we want `reuse_thread` at all, or should all automations stay new-thread-per-run for context hygiene?
5. For `new_worktree_per_run`, should the automation own cleanup policy, or should cleanup stay fully manual in the first version?

## Final Recommendation

Implement `Automations` as a new first-class, chat-first domain.

Do not extend `Repository.saveAutomation` into this product.

Start with:

- dedicated route
- manual runs
- reused worktree
- new thread per run
- run history

Then add scheduling as phase 2 once the product model and deep-link flow feel solid.
