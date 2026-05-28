# CodeSymphony CLI Chat

This context covers how a chat thread chooses and keeps using a CLI agent, model, and optional provider configuration across turns.

## Language

**Thread selection**:
The persisted choice of agent, model, and optional model provider that governs how a chat thread runs.
_Avoid_: session settings, runtime config

**Alias-only model selection**:
A model selection that changes the model identifier while still relying on the local CLI account and auth flow.
_Avoid_: custom provider, remote endpoint

**Provider-backed model selection**:
A model selection that routes a thread through a stored provider endpoint and credentials.
_Avoid_: built-in model, alias-only model

**Provider-backed Claude selection**:
A Claude thread selection that uses a provider-backed model selection instead of local Claude Code auth.
_Avoid_: custom Claude model

**In-thread model switch**:
A same-agent model change on an existing thread that keeps the provider session and takes effect on the next turn.
_Avoid_: forked thread, silent new session

**Plan execution target**:
The explicit agent, model, and optional provider chosen when approving a pending plan.
_Avoid_: composer state, inferred target

**Plan execution switch**:
Plan approval that keeps execution in the source thread by persisting a new same-agent thread selection before the execution turn starts.
_Avoid_: one-off override, transient target

**Plan execution handoff**:
Plan approval that creates a new execution thread because the target cannot run as a same-thread switch.
_Avoid_: implicit retry, background clone

## Relationships

- A **Thread selection** chooses exactly one agent and one model
- A **Thread selection** persists across turns until explicitly changed
- A **Thread selection** may also choose one **Provider-backed model selection**
- A **Provider-backed Claude selection** is a Claude-flavoured **Provider-backed model selection**
- An **Alias-only model selection** and a **Provider-backed model selection** are distinct kinds of model selection
- An **In-thread model switch** preserves the existing provider session
- An **In-thread model switch** applies its new model on the next turn, not the in-flight turn
- A **Plan execution target** is chosen explicitly at approval time
- A **Plan execution switch** persists its new thread selection before execution starts
- A **Plan execution handoff** creates a new default execution thread on the same worktree
- A **Plan execution handoff** inherits permission settings from the source thread

## Example dialogue

> **Dev:** "User wants to switch from one Claude model to another in the same thread. Is that a custom Claude model?"
> **Domain expert:** "Only if that thread is using a provider-backed Claude selection. If it still relies on local Claude Code auth, that's just an alias-only model selection."
>
> **Dev:** "If the user changes model in the same thread, do we restart the provider session?"
> **Domain expert:** "No. An in-thread model switch keeps the provider session and the new model starts on the next turn."
>
> **Dev:** "The user approved a plan and picked Codex instead of Claude. Is that just another in-thread model switch?"
> **Domain expert:** "No. That's a plan execution handoff. Agent changes do not stay in the same thread."
>
> **Dev:** "What if the user keeps the same agent but the source thread is provider-backed Claude and locked?"
> **Domain expert:** "Approval still succeeds, but it becomes a plan execution handoff to a new execution thread."

## Worktree Live State

**Worktree git status**:
The current branch, upstream relation, ahead/behind counts, and uncommitted entries for one Worktree.
_Avoid_: git cache row, panel data

**Worktree git freshness**:
The rule set that keeps one Worktree git status current across live updates, manual refresh, startup seed, and cached fallback.
_Avoid_: invalidate query, socket plumbing

**Source Control projection**:
The UI-facing projection that turns one Worktree git status into Source Control entries, badge counts, sync availability, and panel actions.
_Avoid_: git owner, transport state machine

**Worktree activity**:
An activity on one Worktree that may change file-derived or git-derived state and therefore requires the right live projections to refresh.
_Avoid_: raw watcher event, ad-hoc invalidation

## Worktree Live State Relationships

- A **Worktree git status** belongs to exactly one Worktree
- **Worktree git freshness** keeps one **Worktree git status** current
- A **Source Control projection** is derived from one **Worktree git status**
- A **Worktree activity** may require **Worktree git freshness** to refresh its **Worktree git status**

## Flagged ambiguities

- "custom Claude model" was used to mean both alias-only Claude entries and provider-backed Claude entries; resolved: the risky case is **Provider-backed Claude selection**
- "execute approved plan with another model" was ambiguous between same-thread switching and new-thread delegation; resolved:
  - same-agent valid target => **Plan execution switch**
  - invalid same-thread target or cross-agent target => **Plan execution handoff**

## Production Diagnostics

**Issue Report**:
A user-facing local artifact that captures a user's description of a production problem together with the relevant diagnostic context from the current app state.
_Avoid_: bug ticket, debug log, uploaded issue

**Diagnostic Capture**:
The redacted runtime, workspace, thread, and instrumentation evidence attached to an Issue Report.
_Avoid_: raw terminal dump, source snapshot, telemetry upload

## Production Diagnostics Relationships

- An **Issue Report** contains exactly one user description
- An **Issue Report** may include one **Diagnostic Capture**
- A **Diagnostic Capture** is scoped to the current workspace context by default
- A **Diagnostic Capture** excludes raw terminal output, source snippets, environment values, API keys, tokens, and provider credentials
