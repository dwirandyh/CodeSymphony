# Handoff — Split-pane independent chat panes

Date: 2026-06-16
Branch: `feat/tab/split-tab`
Author of prior session: Kiro (Claude)

## Goal (the one remaining objective)

Make the two split-screen chat panes **fully independent**. With two threads that
have never sent a message, splitting must NOT leave one pane stuck on a shimmer
("loading-thread") with no composer. Each pane renders its OWN
ChatMessageList + Composer + gates and sends/stops/queues to its OWN thread
regardless of which pane is focused. User chose the full solution: "Penuh: 2 pane
chat independen", "Borong full sekarang" (do it all in one go).

Two earlier objectives on this branch are DONE and verified (do not redo):
- Split tab strips rise into the header tab row, aligned to the editor divider.
- codex ENOENT crash fix (runtime no longer exits 7 on missing `codex` binary).

## Current state — what is DONE and green

The architecture is: each pane renders `<ChatPane>`, which calls
`useThreadPaneSession(threadId, deps)`. The pane hook keeps all per-thread refs/
streams local (no global `selectedThreadId` collapsing) and delegates cross-cutting
thread-list mutations to the parent `useChatSession` via **thread-explicit**
callbacks. The queue is owned self-contained inside the pane hook (mirroring
`usePendingGates`' own-api pattern).

Done + tests green (TDD red→green throughout):
- `useChatSession.ts`: added thread-explicit `setThreadPermissionMode(threadId, mode)`;
  refactored `setComposerPermissionMode` to delegate to it; added to hook return.
  (`submitMessage(..., targetThreadId?)`, `stopAssistantRun(targetThreadId?)`,
  `setThreadMode`, `setThreadAgentSelection` were already thread-explicit.)
- `useThreadPaneSession.ts` (NEW): per-pane session. Delegated composer mutations
  (`setComposerMode/AgentSelection/PermissionMode`, `stopAssistantRun`) bind the
  pane's own threadId. Self-contained queue: `queuedMessages` query +
  `queueDraft/updateQueuedDraft/dispatchQueuedDraft/cancelQueuedDraftDispatch/
  deleteQueuedDraft`. 9 tests green.
- `ChatPane.tsx` (NEW): composes the pane hook + ChatMessageList + gate cards
  (Permission/Question) + Composer + PlanDecisionComposer, with per-pane gate-nav
  cursors + thinking/working derivation. 5 tests green.
- `WorkspacePageContent.tsx`: `renderPaneContent` chat branch now renders
  `<ChatPane>` (replaced the old `isCurrentThread ? ... : "loading-thread"` hack).
- `threadLiveData.ts` (NEW): `toPlainChatMessage/toPlainChatEvent/cloneSortedIfNeeded`.
- `useThreadEventStream.ts`: made safe for 2 concurrent instances (removed
  `activeThreadIdRef.current !== ...` guards).
- `apps/web` **lint (tsc --noEmit) passes clean.**

See `git status` / `git diff` on branch `feat/tab/split-tab` for exact changes.
Modified + untracked files listed there; do not re-enumerate from memory.

## BLOCKER — remaining test failures to triage

Full `bun run --filter @codesymphony/web test` (run at 17:24): **7 failed | 2071 passed**.
After fixing the type error in the queue test (added `model` to the
`setComposerAgentSelection` arg), the `useThreadPaneSession` queue test now passes.
A later scoped re-run showed **6 remaining ×**:

- `SettingsDialog > persists default agent selections to localStorage`
- `SettingsDialog > renders settings model options with composer-style model and provider detail`
- `Composer > shows the dynamic Codex catalog even when a Codex CLI default model is configured`
- `Composer > shows Cursor model options and emits thread agent selection updates`
- `PlanDecisionComposer > clicks Handover plan in the handoff-required flow and requests handoff execution`
- `PlanDecisionComposer > preserves the selected handoff target across parent rerenders with unchanged current thread values`

### FIRST STEP for next session (do not skip)
Determine whether these 6 are **pre-existing on the branch base** or **introduced**
by this work. Fastest check: `git stash` the working tree (or check out the
untracked files aside) and run just those files:
```
bun run --filter @codesymphony/web test -- SettingsDialog Composer PlanDecisionComposer
```
- If they fail on the clean base too → pre-existing, unrelated to this work; note
  and move on.
- If they pass on base but fail with changes → introduced. Likely suspects:
  the new `lib/api` mock shape in `useThreadPaneSession.test.tsx` leaking, or a
  shared-module side effect. These three components are about agent/model selection
  + plan handoff — none are touched directly by ChatPane, so a test-isolation/mock
  bleed is the leading hypothesis.

NOTE: prior session recorded a shell-env leak `CODEX_BINARY_PATH=/opt/homebrew/bin/codex`
that makes 2 *runtime* skills tests fail unless run with `env -u CODEX_BINARY_PATH`.
That is a different set (runtime, not web) but the Codex web failures above are worth
checking against env state too.

## After the blocker is cleared

1. Manual verification with `make dev` (ports: runtime 4331, web 5174, db dev.db).
   DO NOT touch prod port 4322. Reproduce: open 2 never-messaged threads → split →
   confirm BOTH panes show a composer + correct empty state (no shimmer), and that
   sending/stopping/queuing in one pane targets only that pane's thread.
2. Mark task #6 complete.

## Conventions to follow (from CLAUDE.md / skills)

- TDD red-green-refactor for every change (write the failing test first).
- Communicate in caveman/ultra-compressed mode.
- Vitest runs under Node, not Bun — no `bun:sqlite` in tests.
- React best practices: minimize re-renders, no waterfalls.

## Suggested skills

- **simplify** — after the 6 failures are resolved, run over the changed code
  (`ChatPane.tsx`, `useThreadPaneSession.ts`, the `renderPaneContent` wiring) to
  catch duplicated gate-nav logic that could be shared with `WorkspacePageContent`.
- **review** — before opening/finalizing the PR for `feat/tab/split-tab`.
- **security-review** — light pass; no auth/network changes here, but the branch
  touches a runtime spawn path (codex ENOENT fix).
