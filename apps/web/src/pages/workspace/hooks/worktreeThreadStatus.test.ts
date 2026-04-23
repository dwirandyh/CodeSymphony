import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatThread, ChatThreadSnapshot } from "@codesymphony/shared-types";
import {
  aggregateWorktreeStatus,
  derivePendingPermissionRequests,
  deriveThreadUiStatus,
  hasRunningAssistantActivity,
} from "./worktreeThreadStatus";

function makeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "t1",
    worktreeId: "wt1",
    title: "Thread",
    kind: "default",
    permissionProfile: "default",
    permissionMode: "default",
    mode: "default",
    titleEditedManually: false,
    claudeSessionId: null,
    active: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ChatEvent> & Pick<ChatEvent, "id" | "threadId" | "idx" | "type">): ChatEvent {
  return {
    id: overrides.id,
    threadId: overrides.threadId,
    idx: overrides.idx,
    type: overrides.type,
    payload: overrides.payload ?? {},
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
  };
}

function makeSnapshot(events: ChatEvent[] = []): ChatThreadSnapshot {
  return {
    messages: [],
    events,
    timeline: {
      timelineItems: [],
      summary: {
        oldestRenderableKey: null,
        oldestRenderableKind: null,
        oldestRenderableMessageId: null,
        oldestRenderableHydrationPending: false,
        headIdentityStable: true,
      },
      newestSeq: null,
      newestIdx: events.length ? events[events.length - 1]!.idx : null,
      messages: [],
      events,
    },
  };
}

describe("worktreeThreadStatus", () => {
  it("returns waiting_approval for unresolved permission", () => {
    const thread = makeThread();
    const snapshot = makeSnapshot([
      makeEvent({
        id: "e1",
        threadId: thread.id,
        idx: 1,
        type: "permission.requested",
        payload: { requestId: "perm-1", toolName: "Bash" },
      }),
    ]);

    expect(deriveThreadUiStatus(thread, snapshot)).toBe("waiting_approval");
  });

  it("extracts edit target from OpenCode-style filePath permission payloads", () => {
    const events = [
      makeEvent({
        id: "e1",
        threadId: "t1",
        idx: 1,
        type: "permission.requested",
        payload: {
          requestId: "perm-1",
          toolName: "Write",
          toolInput: { filePath: "src/opencode.ts" },
        },
      }),
    ];

    expect(derivePendingPermissionRequests(events)).toEqual([
      expect.objectContaining({
        requestId: "perm-1",
        toolName: "Write",
        editTarget: "opencode.ts",
      }),
    ]);
  });

  it("returns waiting_approval for unresolved question", () => {
    const thread = makeThread();
    const snapshot = makeSnapshot([
      makeEvent({
        id: "e1",
        threadId: thread.id,
        idx: 1,
        type: "question.requested",
        payload: { requestId: "q-1", questions: [{ question: "Proceed?" }] },
      }),
    ]);

    expect(deriveThreadUiStatus(thread, snapshot)).toBe("waiting_approval");
  });

  it("returns review_plan when plan is pending after ExitPlanMode completes", () => {
    const thread = makeThread();
    const snapshot = makeSnapshot([
      makeEvent({
        id: "e1",
        threadId: thread.id,
        idx: 1,
        type: "plan.created",
        payload: { content: "Plan body", filePath: "/tmp/.claude/plans/plan.md" },
      }),
      makeEvent({
        id: "e2",
        threadId: thread.id,
        idx: 2,
        type: "tool.started",
        payload: { toolName: "ExitPlanMode", toolUseId: "exit-1" },
      }),
      makeEvent({
        id: "e3",
        threadId: thread.id,
        idx: 3,
        type: "tool.finished",
        payload: { precedingToolUseIds: ["exit-1"] },
      }),
    ]);

    expect(deriveThreadUiStatus(thread, snapshot)).toBe("review_plan");
  });

  it("falls back to review_plan after chat completion for older plan histories", () => {
    const thread = makeThread();
    const snapshot = makeSnapshot([
      makeEvent({
        id: "e1",
        threadId: thread.id,
        idx: 1,
        type: "plan.created",
        payload: { content: "Plan body", filePath: "/tmp/.claude/plans/plan.md" },
      }),
      makeEvent({
        id: "e2",
        threadId: thread.id,
        idx: 2,
        type: "chat.completed",
        payload: {},
      }),
    ]);

    expect(deriveThreadUiStatus(thread, snapshot)).toBe("review_plan");
  });

  it("returns idle after a pending plan is dismissed", () => {
    const thread = makeThread();
    const snapshot = makeSnapshot([
      makeEvent({
        id: "e1",
        threadId: thread.id,
        idx: 1,
        type: "plan.created",
        payload: { content: "Plan body", filePath: "/tmp/.claude/plans/plan.md" },
      }),
      makeEvent({
        id: "e2",
        threadId: thread.id,
        idx: 2,
        type: "chat.completed",
        payload: {},
      }),
      makeEvent({
        id: "e3",
        threadId: thread.id,
        idx: 3,
        type: "plan.dismissed",
        payload: { filePath: "/tmp/.claude/plans/plan.md" },
      }),
    ]);

    expect(deriveThreadUiStatus(thread, snapshot)).toBe("idle");
  });

  it("returns idle for bogus streaming fallback plans without a real write", () => {
    const thread = makeThread();
    const snapshot = makeSnapshot([
      makeEvent({
        id: "e1",
        threadId: thread.id,
        idx: 1,
        type: "plan.created",
        payload: {
          content: "Hello there",
          filePath: "streaming-plan",
          source: "streaming_fallback",
        },
      }),
      makeEvent({
        id: "e2",
        threadId: thread.id,
        idx: 2,
        type: "chat.completed",
        payload: {},
      }),
    ]);

    expect(deriveThreadUiStatus(thread, snapshot)).toBe("idle");
  });

  it("returns running for active thread without gates", () => {
    const thread = makeThread({ active: true });
    expect(deriveThreadUiStatus(thread, makeSnapshot())).toBe("running");
  });

  it("returns running for inactive thread when an unresolved tool is still active in events", () => {
    const thread = makeThread({ active: false });
    const snapshot = makeSnapshot([
      makeEvent({
        id: "e1",
        threadId: thread.id,
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Task", toolUseId: "task-1" },
      }),
      makeEvent({
        id: "e2",
        threadId: thread.id,
        idx: 2,
        type: "subagent.started",
        payload: { toolUseId: "subagent-1", agentId: "agent-1", agentType: "Explore", description: "Scan files" },
      }),
    ]);

    expect(deriveThreadUiStatus(thread, snapshot)).toBe("running");
  });

  it("clears running fallback after a terminal chat event", () => {
    const events = [
      makeEvent({
        id: "e1",
        threadId: "t1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Task", toolUseId: "task-1" },
      }),
      makeEvent({
        id: "e2",
        threadId: "t1",
        idx: 2,
        type: "chat.completed",
        payload: { messageId: "m-1" },
      }),
    ];

    expect(hasRunningAssistantActivity(events)).toBe(false);
  });

  it("ignores delayed metadata tool.finished after chat completion", () => {
    const events = [
      makeEvent({
        id: "e1",
        threadId: "t1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Task", toolUseId: "task-1" },
      }),
      makeEvent({
        id: "e2",
        threadId: "t1",
        idx: 2,
        type: "chat.completed",
        payload: { messageId: "m-1" },
      }),
      makeEvent({
        id: "e3",
        threadId: "t1",
        idx: 3,
        type: "tool.finished",
        payload: {
          source: "chat.thread.metadata",
          summary: "Updated thread title",
          threadTitle: "Async title",
        },
      }),
    ];

    expect(hasRunningAssistantActivity(events)).toBe(false);
  });

  it("returns idle for inactive thread without gates", () => {
    const thread = makeThread({ active: false });
    expect(deriveThreadUiStatus(thread, makeSnapshot())).toBe("idle");
  });

  it("prioritizes waiting approval over running during aggregation", () => {
    const runningThread = makeThread({ id: "t-running", active: true });
    const waitingThread = makeThread({ id: "t-waiting", active: false });

    const result = aggregateWorktreeStatus([
      { thread: runningThread, snapshot: makeSnapshot() },
      {
        thread: waitingThread,
        snapshot: makeSnapshot([
          makeEvent({
            id: "e1",
            threadId: waitingThread.id,
            idx: 1,
            type: "permission.requested",
            payload: { requestId: "perm-1", toolName: "Bash" },
          }),
        ]),
      },
    ]);

    expect(result).toEqual({ kind: "waiting_approval", threadId: "t-waiting" });
  });

  it("returns idle for empty worktree thread list", () => {
    expect(aggregateWorktreeStatus([])).toEqual({ kind: "idle", threadId: null });
  });
});
