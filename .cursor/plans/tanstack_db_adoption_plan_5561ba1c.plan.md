---
name: TanStack DB Adoption Plan
overview: "Adopt TanStack DB selectively as the client-side reactive data layer for server-authoritative collections and thread-local streaming state, starting with active chat threads, then shared workspace entities. Pre-release assumption: internal hook/component breaking changes are acceptable; persistence migrations are out of scope."
todos:
  - id: phase-1-setup
    content: Install @tanstack/db, @tanstack/react-db, @tanstack/query-db-collection. Create collections/ and registry/ structure plus explicit ownership rules for QueryCollection vs LocalOnly data.
    status: completed
  - id: phase-1-events
    content: Create threadEventsCollection(threadId) and threadMessagesCollection(threadId) as LocalOnly collections plus a threadStreamStateRegistry for lastEventIdx, lastMessageSeq, snapshot keys, and disposal lifecycle.
    status: completed
  - id: phase-1-stream
    content: Refactor useThreadEventStream to write only into LocalOnly thread collections and registry metadata. Preserve reconnect/afterIdx semantics and never write SSE payloads into a QueryCollection.
    status: completed
  - id: phase-1-chat-session
    content: Refactor useChatSession to read active-thread events/messages via useLiveQuery while keeping ephemeral UI state in React. Remove array merge state, but keep explicit selection, waiting, and optimistic thread state.
    status: completed
  - id: phase-1-gates
    content: Refactor usePendingGates to derive pending gates from live queries, while keeping busy/dismissed/optimistic close state local to the hook.
    status: completed
  - id: phase-1-snapshot
    content: Replace snapshotSeed with an explicit hydrator that seeds/reconciles LocalOnly collections from timeline snapshots and never lets older snapshots overwrite newer streamed rows.
    status: completed
  - id: phase-1-tests
    content: Update chat session and event stream tests to cover reconnect, thread switch, snapshot merge, collection disposal, and no duplicate/no dropped event invariants.
    status: completed
  - id: phase-2-repos
    content: Create repositoriesCollection (QueryCollection) and derived worktree selectors. Refactor useRepositoryManager to consume normalized data without repeated repo/worktree scans.
    status: completed
  - id: phase-2-threads
    content: Create threadsCollection(worktreeId) QueryCollection factory. Consolidate duplicate thread-list fetching across useWorktreeStatuses, useBackgroundWorktreeStatusStream, and useThreads; keep per-thread status snapshots on targeted React Query hooks until a normalized status store exists.
    status: completed
  - id: phase-2-sync
    content: Refactor useWorkspaceSyncStream and useBackgroundWorktreeStatusStream to patch shared thread/repository collections and targeted status snapshot queries instead of broad repositories.all invalidation.
    status: completed
  - id: phase-3-git-files
    content: Create gitStatusCollection(worktreeId) and fileIndexCollection(worktreeId). Refactor useGitChanges, ExplorerPanel, and Composer to subscribe to worktree-scoped live query slices instead of prop-drilled arrays.
    status: completed
  - id: phase-4-providers
    content: Create modelProvidersCollection and remove duplicate provider fetch paths between useModelProviders.ts and SettingsDialog.tsx.
    status: completed
isProject: false
---

# TanStack DB Adoption Plan

## Current Architecture Pain Points

Based on deep analysis of the entire `apps/web/src` frontend:

### Chat Session (Critical -- highest impact)
- `useChatSession.ts` is ~1250 lines with **20+ useRef** trackers and **10 useState** buckets
- Manual event deduplication via `seenEventIdsByThreadRef` (Map of Sets)
- `insertAllEvents` does **full array concat + sort O((n+m) log(n+m))** on every SSE batch
- `applyMessageMutations` scans entire messages array per RAF flush
- Timeline fingerprinting uses **JSON.stringify on signature arrays** every render cycle
- Every `setEvents`/`setMessages` creates new array refs, triggering re-renders across the entire page

### Repository/Worktree Entities (Medium impact)
- Nested `Repository[]` with embedded `worktrees` -- repeated O(repos x worktrees) scans for selection, branch lookup, `repositoryIdByWorktreeId`
- `useBackgroundWorktreeStatusStream` rebuilds `repositoryIdByWorktreeId` map from scratch on every `repositories` change
- Thread lists fetched redundantly: `useWorktreeStatuses` + `useBackgroundWorktreeStatusStream` + `useThreads` all hit `threads.list(worktreeId)`
- `repositories.all` invalidated on **every** workspace sync event -- triggers full page re-render cascade

### Git/File Data (Lower impact but still beneficial)
- Git status polled every 30s + invalidated by SSE events -- can double-fetch
- File index (60s poll) passed as full array to Composer, CodeEditorPanel, ExplorerPanel
- `usePendingGates` scans **full events array** to derive pending permissions/questions

### Rendering
- `WorkspacePage` is monolithic -- any state change re-renders entire tree
- `WorkspaceHeader`, `Composer`, `ChatMessageList` are **not** wrapped in `React.memo`
- `WorkspaceExplorerPanel` renders full recursive file tree without virtualization

---

## Scope Assumptions

- App is pre-release. Internal hook/component breakage is acceptable if it simplifies the frontend state model.
- No runtime or database schema migration work is required for this plan.
- TanStack DB is not a blanket replacement for all React state. Ephemeral UI state stays local.
- This plan focuses on correctness and state ownership first, then render/update efficiency. It does not try to solve all `WorkspacePage` decomposition work in the same initiative.

## Recommended State Ownership Model

### Server-authoritative QueryCollections

- `repositoriesCollection` as a singleton QueryCollection
- `modelProvidersCollection` as a singleton QueryCollection
- `threadsCollection(worktreeId)` as a keyed QueryCollection factory
- `gitStatusCollection(worktreeId)` as a keyed QueryCollection factory
- `fileIndexCollection(worktreeId)` as a keyed QueryCollection factory

These collections are refreshed from `queryFn` results and should only hold data where the server response is authoritative.

### Stream-authoritative LocalOnly collections

- `threadEventsCollection(threadId)` as a LocalOnly keyed factory
- `threadMessagesCollection(threadId)` as a LocalOnly keyed factory

These collections are written by:

- initial or follow-up timeline snapshot hydration
- active-thread SSE handlers
- optimistic message insertion and reconciliation

### Explicit registries that must remain outside TanStack DB

- `threadStreamStateRegistry` keyed by `threadId` for `lastEventIdx`, `lastMessageSeq`, `lastAppliedSnapshotKey`, reconnect timers, and disposal state
- active-thread React state for `selectedThreadId`, `waitingAssistant`, `sendingMessage`, stop/close actions, optimistic created/deleted thread ids, and dialog state
- gate-local UI state such as resolving permission ids, answering question ids, dismissed question ids, and optimistic plan close state

### Hard Rules

1. **Never write SSE deltas into a QueryCollection.** `QueryCollection` refetches are authoritative and can overwrite local writes.
2. **Active-thread events/messages live in LocalOnly collections.** Snapshot hydration may seed or merge them, but only through one shared hydrator.
3. **On thread open or reconnect, compute `afterIdx` from `threadStreamStateRegistry`, seed from snapshot if needed, then attach SSE.**
4. **Older snapshots must never replace newer streamed rows.** The hydrator compares `newestIdx` and `newestSeq` before applying.
5. **Background threads do not keep full event/message collections hot by default.** They patch thread list and targeted status data only, unless promoted to the active thread.
6. **Collection factories must be disposable and bounded.** Keep only active or recently-viewed thread collections to avoid unbounded client memory growth.
7. **Incremental migration is mandatory.** Each phase must ship behind repo-local abstractions so hooks can migrate one area at a time.

---

## Migration Phases

### Phase 1: Foundation + Active Thread Streaming (Highest Impact)

Scope: only the active thread's full message/event/timeline path. Background thread status handling stays on the current path until Phase 2.

**New packages:**
```
@tanstack/db @tanstack/react-db @tanstack/query-db-collection
```

**New files to create:**
- `apps/web/src/collections/threadEvents.ts` -- `threadEventsCollection(threadId)` LocalOnly collection
- `apps/web/src/collections/threadMessages.ts` -- `threadMessagesCollection(threadId)` LocalOnly collection
- `apps/web/src/collections/threadCollections.ts` -- keyed collection registry plus disposal helpers
- `apps/web/src/collections/threadStreamState.ts` -- registry for `lastEventIdx`, `lastMessageSeq`, `lastAppliedSnapshotKey`, and reconnect metadata
- `apps/web/src/collections/threadHydrator.ts` -- single hydrator for snapshot seeding and merge rules

**Files to modify:**
- [`apps/web/src/pages/workspace/hooks/chat-session/useThreadEventStream.ts`](apps/web/src/pages/workspace/hooks/chat-session/useThreadEventStream.ts) -- write stream payloads into LocalOnly collections and `threadStreamStateRegistry`, preserve reconnect and `afterIdx` behavior, and keep targeted query invalidation for status/timeline snapshots where still needed
- [`apps/web/src/pages/workspace/hooks/chat-session/useChatSession.ts`](apps/web/src/pages/workspace/hooks/chat-session/useChatSession.ts) -- replace `useState<ChatEvent[]>` and `useState<ChatMessage[]>` with `useLiveQuery` on the active thread's LocalOnly collections, while leaving selection, optimistic thread creation/deletion, and waiting-assistant state in React
- [`apps/web/src/pages/workspace/hooks/chat-session/snapshotSeed.ts`](apps/web/src/pages/workspace/hooks/chat-session/snapshotSeed.ts) -- either replace with or reduce to the shared thread hydrator
- [`apps/web/src/pages/workspace/hooks/usePendingGates.ts`](apps/web/src/pages/workspace/hooks/usePendingGates.ts) -- derive pending gates from live query selectors, but keep busy/dismissed state local
- [`apps/web/src/hooks/queries/useThreadSnapshot.ts`](apps/web/src/hooks/queries/useThreadSnapshot.ts) -- keep as the authoritative timeline snapshot fetch feeding the hydrator for now

**Phase 1 invariants:**
- reconnect resumes with `afterIdx` from `threadStreamStateRegistry`
- snapshot hydration never removes newer streamed rows
- switching threads clears or disposes only the active thread's LocalOnly collections
- no SSE codepath writes directly into a QueryCollection
- no duplicate or dropped events across snapshot + stream interleaving

### Phase 2: Repository + Worktree Entities

Normalize repository/worktree data and consolidate duplicate thread-list fetching. Do not force per-thread status snapshots into TanStack DB until there is a normalized status shape worth storing.

**New files:**
- `apps/web/src/collections/repositories.ts` -- QueryCollection wrapping `api.listRepositories`
- `apps/web/src/collections/worktrees.ts` -- derived selectors or helper queries over `repositoriesCollection` (flattened worktree list with `repositoryId`)
- `apps/web/src/collections/threads.ts` -- `threadsCollection(worktreeId)` QueryCollection factory wrapping `api.listThreads`

**Files to modify:**
- [`apps/web/src/pages/workspace/hooks/useRepositoryManager.ts`](apps/web/src/pages/workspace/hooks/useRepositoryManager.ts) -- replace `useRepositories()` + manual selection scans with normalized collection reads; keep mutation side-effects explicit
- [`apps/web/src/pages/workspace/hooks/useBackgroundWorktreeStatusStream.ts`](apps/web/src/pages/workspace/hooks/useBackgroundWorktreeStatusStream.ts) -- consume shared `threadsCollection(worktreeId)` data instead of issuing its own thread-list queries; keep targeted `statusSnapshot` invalidation/querying for now
- [`apps/web/src/hooks/queries/useWorktreeStatuses.ts`](apps/web/src/hooks/queries/useWorktreeStatuses.ts) -- consume shared thread-list data instead of fetching `threads.list(worktreeId)` again
- [`apps/web/src/pages/workspace/hooks/useWorkspaceSyncStream.ts`](apps/web/src/pages/workspace/hooks/useWorkspaceSyncStream.ts) -- invalidate or refresh specific collection factories and targeted status snapshot queries instead of broad `repositories.all`
- [`apps/web/src/components/workspace/RepositoryPanel.tsx`](apps/web/src/components/workspace/RepositoryPanel.tsx) -- consume normalized repo/worktree data from live queries instead of repeated nested scans

**Expected impact:**
- remove repeated O(n) repo/worktree lookup work from selection and branch resolution paths
- eliminate duplicate thread-list fetching across `useThreads`, `useWorktreeStatuses`, and `useBackgroundWorktreeStatusStream`
- reduce `repositories.all` invalidation to only repo-level changes that actually need it

### Phase 3: Git Status + File Index

**New files:**
- `apps/web/src/collections/gitStatus.ts` -- `gitStatusCollection(worktreeId)` QueryCollection factory, 30s refetch
- `apps/web/src/collections/fileIndex.ts` -- `fileIndexCollection(worktreeId)` QueryCollection factory, 60s refetch

**Files to modify:**
- [`apps/web/src/pages/workspace/hooks/useGitChanges.ts`](apps/web/src/pages/workspace/hooks/useGitChanges.ts) -- read worktree-scoped git status from the collection and keep mutations explicit
- [`apps/web/src/components/workspace/WorkspaceExplorerPanel.tsx`](apps/web/src/components/workspace/WorkspaceExplorerPanel.tsx) -- build file tree from `useLiveQuery` on `fileIndexCollection(worktreeId)`
- [`apps/web/src/components/workspace/composer/Composer.tsx`](apps/web/src/components/workspace/composer/Composer.tsx) -- use a file index slice instead of receiving the full array through props

**Expected impact:**
- remove large prop-drilled file index arrays from `WorkspacePage`
- make git/file consumers subscribe to worktree-scoped data rather than whole-page state
- preserve targeted invalidation for git updates without broad workspace refetches

### Phase 4: Model Providers + Remaining State

- `apps/web/src/collections/modelProviders.ts` -- singleton QueryCollection for model providers
- Replace `useState` in `useModelProviders.ts` and duplicate fetch in `SettingsDialog.tsx`
- Consolidate remaining direct `api.*` fetch paths only where the data is shared and server-authoritative

### Deferred / Non-Goals

- `WorkspacePage` decomposition, `React.memo` boundaries, and explorer virtualization are separate efforts
- branch list fetching in `SettingsDialog` can remain direct unless it becomes shared state
- not every single `useState` should move to TanStack DB; ephemeral UI state stays in React

---

## Acceptance Criteria

### Correctness

- Active-thread reconnect tests prove no duplicate or missing events across snapshot + SSE interleaving.
- Thread switching does not leak `waitingAssistant`, gate state, or optimistic thread state across threads.
- Older timeline snapshots never overwrite newer streamed rows.
- No SSE codepath writes directly into a `QueryCollection`.

### Data Flow

- `useChatSession` no longer stores active-thread `messages` and `events` in React state arrays.
- `useThreads`, `useWorktreeStatuses`, and `useBackgroundWorktreeStatusStream` share one thread-list source per worktree.
- Git/file consumers subscribe to worktree-scoped collection slices instead of receiving large arrays from `WorkspacePage`.
- Workspace sync stops invalidating `repositories.all` for unrelated thread, git, or file events.

### Verification

- Add unit tests for collection hydration and disposal.
- Update existing hook tests to cover reconnect, snapshot merge, and targeted invalidation behavior.
- Use `debugLog` instrumentation during rollout to verify stream ordering and render-frequency regressions.

## Risks and Mitigations

- **TanStack DB is still beta**: Keep collection creation behind repo-local wrappers so the app is not coupled directly to unstable package APIs.
- **Stream/snapshot coordination is easy to get wrong**: Centralize it in one hydrator plus one thread stream registry, and add reconnect/interleaving tests before wider rollout.
- **Collection registry lifecycle can leak memory**: Use explicit disposal helpers and keep only active or recently-viewed thread collections alive.
- **Test migration cost**: Existing tests mock `api` and `QueryClient`; collection-based code needs registry-aware helpers. Keep `api.ts` as the transport layer and add small test utilities instead of rewriting every test from scratch.
- **TanStack DB will not solve all rerender issues by itself**: `WorkspacePage` structure and heavy timeline derivation still need follow-up work after the state model is stabilized.
