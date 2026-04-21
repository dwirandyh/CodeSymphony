# Codex Plan Activity Architecture

## Goal

Make Codex plan-mode behavior as reliable as Claude for:

- non-mutating exploration before a plan
- consistent tool/activity rendering before the plan card
- strict mutation denial during plan mode
- replayable thread state after refresh and reconnect

## Current Direction

The first refactor slice is already in place:

- `apps/runtime/src/codex/collaborationMode.ts`
  Holds plan/default collaboration instructions plus approval-policy helpers.
- `apps/runtime/src/codex/plan.ts`
  Holds plan extraction and plan-content normalization.
- `apps/runtime/src/codex/toolContext.ts`
  Holds raw Codex item -> tool lifecycle normalization.
- `apps/runtime/src/codex/protocolUtils.ts`
  Holds low-level JSON payload coercion helpers.

`apps/runtime/src/codex/sessionRunner.ts` now acts more like transport/orchestration instead of carrying all Codex semantics inline.

## Target Architecture

### 1. Provider transport layer

Responsibility:

- own JSON-RPC process lifecycle
- send requests and receive notifications
- maintain thread/session lifecycle
- remain ignorant of UI concepts

Current file:

- `apps/runtime/src/codex/sessionRunner.ts`

Desired end state:

- transport concerns stay here
- domain mapping keeps moving out

### 2. Codex runtime mapping layer

Responsibility:

- convert raw Codex items and approval requests into normalized runtime events
- classify item types into `Read`, `Glob`, `Grep`, `Search`, `Bash`, `Edit`, `Write`, `Task`, and provider-specific fallbacks
- normalize plan payloads into one plan representation

Current files:

- `apps/runtime/src/codex/toolContext.ts`
- `apps/runtime/src/codex/plan.ts`
- `apps/runtime/src/codex/collaborationMode.ts`

Desired end state:

- every Codex-specific decision is testable without spawning the Codex process
- plan policy and tool normalization are reusable by tests and future adapters

### 3. Runtime event model

Responsibility:

- persist one provider-agnostic event stream
- keep ordering stable across `message.delta`, tool lifecycle, subagent events, and plan lifecycle

Desired invariants:

- pre-plan exploration is never dropped
- plan events never erase earlier tool/message evidence
- mutation-denial in plan mode is explicit in the approval path

### 4. Timeline assembly layer

Responsibility:

- map runtime events into renderable timeline items
- keep ordering deterministic
- collapse noisy raw activity into readable rows without hiding important plan evidence

Desired invariants:

- `user message -> explore/tool activity -> assistant explanation -> plan card`
- plan card remains last
- tool evidence above the plan remains visible after reload/reconnect

### 5. Review UX layer

Responsibility:

- show plan review controls
- show concise evidence that the plan was grounded in real exploration
- keep raw trace available without overwhelming the default view

Future improvement:

- add compact "plan evidence" summary above the card:
  - inspected files
  - searches run
  - commands used

## Implementation Phases

### Phase 1: Completed

- allow non-mutating exploration in Codex plan mode
- keep mutating approvals denied in plan mode
- normalize more Codex item types into tool lifecycle payloads
- split Codex runner internals into focused modules

### Phase 2: Next

- extract a dedicated Codex event normalizer from `sessionRunner.ts`
- emit provider-agnostic intermediate runtime events before persistence
- reduce direct UI dependence on provider-specific raw payload shapes

### Phase 3: After that

- add plan evidence summary item derived from pre-plan tool activity
- expose a compact/default and detailed/expandable view for plan grounding

### Phase 4: Hardening

- add integration coverage for:
  - read/search before plan
  - denied write/edit in plan mode
  - persisted replay after refresh
  - stable order with message/tool/plan mixing

## Non-Negotiable Rules

- Plan mode may inspect; it may not mutate.
- A plan without visible grounding evidence is lower quality than one with evidence.
- Provider-specific payload parsing must live in runtime mapping code, not leak into web rendering logic.
- Timeline ordering rules must be enforced by tests, not by visual inspection alone.
