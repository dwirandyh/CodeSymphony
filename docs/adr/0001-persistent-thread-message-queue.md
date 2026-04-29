# ADR 0001: Persistent Thread Message Queue for CLI Agents

- Status: Proposed
- Date: 2026-04-25

## Context

The current chat flow allows exactly one in-flight assistant run per thread.

- `apps/runtime/src/services/chat/chatService.ts` rejects `sendMessage()` while a thread is active.
- `apps/web/src/pages/workspace/hooks/chat-session/useChatSession.ts` disables the composer whenever the selected thread is not `idle`.
- The composer footer switches its only primary action between `send` and `stop`, so users cannot stage follow-up prompts while Claude, Codex, Cursor, or OpenCode are still working.

The requested product change is:

- users can add more than one follow-up message into a queue
- each queued item can be deleted
- each queued item can be sent immediately from the queue list with a per-item action
- queued items should auto-send in FIFO order once the thread becomes eligible to accept the next user message
- if a queued item becomes eligible while a tool call is still running, the system must wait for the current tool call to finish before handing off to the queued item
- the queue list must render directly above the composer and feel visually attached to it
- the behavior must work for every CLI agent, not just one provider

There are several implementation constraints:

1. The runtime currently models a thread as a single active run plus persisted chat history and persisted chat events.
2. The provider runners expose a common abstraction for `onToolStarted`, `onToolFinished`, `onSubagentStarted`, `onSubagentStopped`, `onQuestionRequest`, `onPermissionRequest`, and final `chat.completed` / `chat.failed`, but they do not expose a provider-neutral “inject a new user message mid-turn” primitive.
3. Attachments can include images stored on disk, so a queue implementation cannot be safely modeled as client-only draft text.
4. The existing timeline/event model represents committed conversation history, not unsent drafts.

## Decision

We will add a persistent, thread-scoped message queue that is managed by the runtime and rendered by the web client.

The core decisions are:

1. Queue items are persisted per thread in the runtime database.
2. Queue items are not part of the chat timeline or `ChatEvent` history.
3. Queued items auto-dispatch in FIFO order when the thread is idle. The oldest queued item is sent as soon as the thread is eligible to accept the next user message and no active run is in progress.
4. Users may also trigger `send now` on any queued item. That item is promoted ahead of the remaining queue and dispatched at the next safe handoff boundary.
5. Dispatch works across all CLI agents through a provider-neutral safe handoff rule:
   - if the thread is idle, dispatch immediately
   - if the thread is running and no tool/subagent is active, interrupt immediately and dispatch after the current run closes
   - if the thread is running with an active tool/subagent, wait for the active tool/subagent boundary to finish, then interrupt and dispatch
   - if the thread is waiting on approval, questions, or plan review, pause auto-dispatch and reject `send now` until the gate is resolved
6. Multiple queued items are dispatched serially. Default order is FIFO, except an item explicitly marked `send now` is promoted ahead of non-requested items.
7. Users may delete queued items before they dispatch, but V1 does not include reordering or editing them.
8. The composer remains editable while a thread is `running`, but not while it is blocked on a user gate.
9. Queue dispatch must be restart-safe: persisted queue rows may outlive in-memory run state, and the runtime must reconcile them when process memory is lost.

## Detailed Design

### 1. Data Model

Add two new runtime tables:

```prisma
enum ChatQueuedMessageStatus {
  queued
  dispatch_requested
  dispatching
}

model ChatQueuedMessage {
  id                  String                  @id @default(cuid())
  threadId            String
  seq                 Int
  content             String
  mode                ChatMode               @default(default)
  status              ChatQueuedMessageStatus @default(queued)
  dispatchRequestedAt DateTime?
  createdAt           DateTime               @default(now())
  updatedAt           DateTime               @updatedAt

  thread      ChatThread              @relation(fields: [threadId], references: [id], onDelete: Cascade)
  attachments ChatQueuedAttachment[]

  @@unique([threadId, seq])
  @@index([threadId, status, dispatchRequestedAt, seq])
}

model ChatQueuedAttachment {
  id              String   @id @default(cuid())
  queuedMessageId  String
  filename         String
  mimeType         String
  sizeBytes        Int
  content          String
  storagePath      String?
  source           String
  createdAt        DateTime @default(now())

  queuedMessage ChatQueuedMessage @relation(fields: [queuedMessageId], references: [id], onDelete: Cascade)

  @@index([queuedMessageId])
}
```

Notes:

- `seq` preserves stable visual ordering in the queue.
- `status=queued` means parked draft.
- `status=dispatch_requested` means the user explicitly chose `send now`, but the runtime has not yet started the final handoff into a real `ChatMessage`.
- `status=dispatching` means the runtime has selected that row for handoff into a real `ChatMessage`, but has not finished committing the dispatch yet.
- Queue rows are hard-deleted once they are dispatched or manually deleted.
- Image attachments follow the same storage strategy as normal message attachments so queue items survive refresh, reconnect, and app restarts.
- `seq` allocation must be atomic per thread. Do not use an unchecked `max(seq) + 1` read-then-write pattern for queued inserts.

### 2. API Surface

Add dedicated queue endpoints instead of extending the timeline endpoint:

- `GET /threads/:id/queue`
- `POST /threads/:id/queue`
- `DELETE /threads/:id/queue/:queueMessageId`
- `POST /threads/:id/queue/:queueMessageId/dispatch`

New shared types:

- `ChatQueuedMessageSchema`
- `ChatQueuedAttachmentSchema`
- `QueueChatMessageInputSchema`

`QueueChatMessageInputSchema` should mirror the send payload closely:

- `content`
- `mode`
- `attachments`
- `expectedWorktreeId`

Reason for dedicated endpoints:

- queue state is operational UI state, not chat history
- queue updates should not force the heavy timeline snapshot contract to grow
- queue reads and writes should stay composable and independently cacheable in React Query

Dispatch endpoint behavior:

- `POST /threads/:id/queue/:queueMessageId/dispatch` marks that row `dispatch_requested`
- if the thread is idle, the requested row dispatches immediately
- if the item is already `dispatch_requested` or `dispatching`, return the current queued row rather than failing
- if the item no longer exists because it was already dispatched or deleted, return `404`

### 3. Runtime Dispatch Rules

Queue dispatch lives in `chatService`, not in the web client.

Implementation shape:

- extract the shared “persist a user message + attachments + emit user delta + schedule assistant” logic from `sendMessage()` into an internal helper
- reuse that helper for both immediate sends and queued dispatches
- keep provider-neutral handoff logic inside runtime state, alongside the existing `threadRuns` map
- add reconciliation logic so persisted queue state remains valid even when `threadRuns` is empty after a runtime restart or crash

Additional in-memory runtime tracking per active thread:

- active tool use IDs
- active subagent tool use IDs
- whether a queue handoff is pending
- which queued row, if any, has explicit `send now` priority

Persisted queue recovery rules:

- `dispatch_requested` is durable user intent, not proof that an in-memory handoff is still active
- `dispatching` is durable progress state, not proof that an in-memory handoff is still active
- on runtime startup, and whenever a thread is loaded while no active run exists for that thread, the runtime must reconcile queued rows
- if queued rows include `dispatch_requested`, the oldest requested row has priority over plain FIFO queued rows
- if a queued row is `dispatching` and the thread is idle, the runtime must either:
  - immediately continue dispatching from that row, or
  - deterministically downgrade orphaned `dispatching` rows back to `dispatch_requested` or `queued`, then restart dispatch selection
- the implementation must choose one of those behaviors and keep it consistent; V1 should prefer immediate resume so auto-dispatch and `send now` survive restarts
- queue state must never remain indefinitely stuck in `dispatch_requested` or `dispatching` solely because in-memory run bookkeeping was lost

State transitions:

1. User queues a draft:
   - runtime persists `ChatQueuedMessage(status=queued)`
   - runtime emits `thread.updated` workspace sync
   - if the thread is idle, runtime immediately begins dispatching the head of the queue

2. User presses `send now` on a queued item:
   - if the thread is idle, runtime immediately dispatches that row
   - if the thread is running, runtime flips that row to `dispatch_requested`
   - runtime emits `thread.updated`

3. Queue selection:
   - when the thread becomes eligible for another user message, runtime selects the next row using:
     - oldest `dispatch_requested` row first
     - otherwise oldest `queued` row
   - runtime flips that row to `dispatching`
   - runtime emits `thread.updated`

4. Active run handoff:
   - while a tool or subagent is active, runtime continues the current run
   - after `tool.finished` or `subagent.finished`, if no active tool/subagent remains and the queue has a selected next row, runtime aborts the current run with a queue-specific cancellation reason
   - once the run clears, runtime dispatches queued items serially using the queue selection rule above

5. Dispatch completion:
   - runtime creates a normal `ChatMessage`
   - runtime creates normal `ChatAttachment` rows
   - runtime deletes the queued row and queued attachments
   - runtime deletes any queued attachment files from disk after the committed attachments have been persisted successfully
   - runtime schedules the assistant exactly as `sendMessage()` already does
   - runtime emits `thread.updated`

6. Queue deletion:
   - manual delete removes the queued row and queued attachments
   - if any queued attachment used filesystem-backed storage, the runtime deletes those files as part of the same cleanup path
   - cleanup must be best-effort but observable in logs so orphaned files can be diagnosed

Queue-specific cancellation payload:

- reuse `chat.completed`
- include `cancelled: true`
- include `cancellationReason: "queued_message_dispatch"`

This preserves the existing event type model while still making the handoff debuggable.

### 4. Provider-Neutral Safe Boundary

The safe handoff boundary is defined by the normalized runtime callbacks, not by provider-specific raw protocol details.

The runtime must only decide handoff using:

- `onToolStarted`
- `onToolFinished`
- `onSubagentStarted`
- `onSubagentStopped`
- `chat.completed`
- `chat.failed`

This keeps the feature valid for:

- Claude
- Codex
- Cursor
- OpenCode

The queue feature must not depend on:

- Anthropic-specific stream internals
- Codex app-server item shapes
- Cursor ACP transport details
- OpenCode session lifecycle details

Those adapters remain responsible only for normalizing provider output into the shared runtime contract.

### 5. Composer UX

The composer stack becomes:

1. queued message list
2. composer shell

Visual rules:

- the queue list sits immediately above the composer
- both blocks share the same width container
- border, background, and corner treatment should make them feel like one attached surface
- when the queue list is present, the queue list owns the top radius and the composer keeps the bottom radius
- the queue list should cap its height and scroll internally once it grows

Each queued row should show:

- 1-2 line content preview
- mode badge (`Execute` / `Plan`)
- attachment count or attachment chip summary when present
- current state badge when `dispatch_requested`
- current state badge when `dispatching`
- `ArrowUp` icon button for `send now`
- delete icon button for removal

V1 behavior:

- queued rows are immutable
- editing a queued row is out of scope
- to change content, delete and re-queue

### 6. Composer Interaction Rules

The composer should stay usable while the thread is actively running.

New footer behavior:

- idle thread:
  - primary action: send
  - secondary action: queue draft
- running thread:
  - primary action: stop
  - secondary action: queue draft
- waiting permission / question / plan review:
  - composer stays hidden, matching the current gate-first UX
  - queued items remain persisted, but auto-dispatch is paused and `send now` is unavailable until the gate is resolved

This is important because queueing is only valuable if the user can continue drafting while the assistant is working.

### 7. Web State Management

Use a dedicated query path:

- `queryKeys.threads.queue(threadId)`

Recommended hook split:

- `useQueuedMessages(threadId)`
- queue mutations colocated with `useChatSession` orchestration or in a dedicated queue hook

UI synchronization rules:

- optimistic insert on queue
- optimistic remove on delete
- optimistic state update on `send now`
- optimistic state update when the runtime marks the queue head as `dispatching`
- invalidate queue query on workspace `thread.updated` and `thread.deleted`

The queue list should not be derived from the timeline snapshot.

That separation keeps streaming timeline churn from causing unnecessary queue/editor rerenders and matches the fact that queued drafts are not historical messages yet.

### 8. Non-Goals

This ADR does not include:

- reordering queued items
- editing queued items in place
- showing queue items inside the chat transcript
- cross-thread queue movement

## Consequences

### Positive

- Users can stage multiple follow-up prompts without waiting for the current run to finish.
- Queued prompts continue progressing automatically without requiring an extra click after they are staged.
- Users can still force a specific queued prompt to go next by using `send now`.
- Queue state survives refresh, reconnect, desktop/web handoff, and runtime restarts.
- The implementation stays provider-neutral by leaning on the normalized runner callbacks.
- The timeline model remains clean because unsent drafts do not become fake chat history.

### Negative

- Runtime complexity increases because queue dispatch now participates in thread lifecycle management.
- Attachment storage and cleanup paths must be implemented twice: queued and committed.
- Composer logic becomes more nuanced because `running` no longer means `fully disabled`.
- Queue recovery semantics must be explicit because database state can outlive process memory.

## Alternatives Considered

### A. Client-only queue in React state

Rejected.

Reasons:

- loses drafts on refresh or app restart
- cannot synchronize between desktop and web clients
- cannot reliably coordinate dispatch with runtime thread lifecycle
- does not handle attachment persistence well

### B. Append queued drafts directly into `ChatEvent`

Rejected.

Reasons:

- queued drafts are not conversation history
- timeline hydration would become noisier and more expensive
- deleting a queued draft would require compensating history semantics

### C. Only dispatch after `chat.completed`

Rejected.

Reasons:

- it does not satisfy the requested “wait for the current tool call to finish, then send”
- it would force users to sit through long post-tool reasoning even after they explicitly requested a handoff

### D. Auto-dispatch only, without per-item `send now`

Rejected.

Reasons:

- users still need an escape hatch to promote a specific queued prompt ahead of the rest of the queue
- a mixed model is more flexible: idle threads continue automatically, while active threads still allow explicit priority override

## Rollout Plan

1. Add schema, shared types, runtime routes, and chat service queue methods.
2. Extract shared message persistence from `sendMessage()` so queued dispatch and immediate send use the same code path.
3. Add queue query/mutations in web state and render the queue list above the composer.
4. Relax composer disabling for `running` threads and add a secondary `Queue` action.
5. Add safe-boundary runtime handoff using normalized tool/subagent lifecycle callbacks.
6. Add test coverage before enabling by default.

## Testing Requirements

Runtime:

- queue text-only and attachment-backed drafts
- delete queued draft and clean up queued attachments
- delete queued draft and remove any filesystem-backed queued attachment files
- dispatch requested draft immediately when idle
- auto-dispatch queued draft immediately when idle
- auto-dispatch the queue head after current tool boundary when a run is active
- prioritize `dispatch_requested` rows ahead of plain queued rows while preserving order within each class
- reject `send now` while a permission/question/plan gate is active
- pause auto-dispatch while a permission/question/plan gate is active, then resume when the gate clears
- recover or resume `dispatch_requested` and `dispatching` rows correctly after runtime restart
- make repeated `send now` requests on the same row idempotent
- avoid `seq` collisions when multiple queue inserts happen concurrently for the same thread

Web:

- composer remains editable while `running`
- queue list renders above and visually attached to composer
- queue row `ArrowUp` and delete actions call the correct mutations
- queue row state reflects transition from `queued` to `dispatch_requested` to `dispatching` when applicable
- optimistic queue state reconciles correctly with workspace sync invalidation
- queue list is hidden when gate-only composers replace the normal composer
