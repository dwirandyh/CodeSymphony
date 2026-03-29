import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatMessage, ChatThread } from "@codesymphony/shared-types";
import {
  applySnapshotSeed,
  applyThreadModeUpdate,
  applyThreadTitleUpdate,
  buildSnapshotKey,
  deriveSelectedThreadUiState,
  extractLatestThreadMetadata,
  mergeEventsWithCurrent,
  prependUniqueEvents,
  prependUniqueMessages,
  resolveSnapshotSeedDecision,
  shouldInvalidateSnapshotImmediatelyAfterSubmit,
} from "./chat-session";

function makeEvent(
  idx: number,
  type: ChatEvent["type"],
  payload: ChatEvent["payload"],
): ChatEvent {
  return {
    id: `event-${idx}`,
    threadId: "thread-1",
    idx,
    type,
    payload,
    createdAt: "2026-02-28T00:00:00.000Z",
  };
}

function makeThread(title: string, id = "thread-1"): ChatThread {
  return {
    id,
    worktreeId: "wt-1",
    title,
    kind: "default",
    permissionProfile: "default",
    mode: "default",
    titleEditedManually: false,
    claudeSessionId: null,
    active: false,
    createdAt: "2026-02-28T00:00:00.000Z",
    updatedAt: "2026-02-28T00:00:00.000Z",
  };
}

function makeMessage(id: string, seq: number): ChatMessage {
  return {
    id,
    threadId: "thread-1",
    seq,
    role: "assistant" as const,
    content: id,
    attachments: [],
    createdAt: "2026-02-28T00:00:00.000Z",
  };
}

function makeSnapshot(overrides?: {
  newestSeq?: number | null;
  newestIdx?: number | null;
}) {
  return {
    timelineItems: [],
    summary: {
      oldestRenderableKey: null,
      oldestRenderableKind: null,
      oldestRenderableMessageId: null,
      oldestRenderableHydrationPending: false,
      headIdentityStable: true,
    },
    newestSeq: overrides?.newestSeq ?? 1,
    newestIdx: overrides?.newestIdx ?? 1,
    messages: [makeMessage("m-1", 1)],
    events: [makeEvent(1, "chat.completed", { messageId: "m-1" })],
  };
}

describe("useChatSession metadata seed helpers", () => {
  it("reads thread title from metadata tool.finished events", () => {
    const events: ChatEvent[] = [
      makeEvent(1, "chat.completed", { messageId: "msg-1" }),
      makeEvent(2, "tool.finished", {
        source: "chat.thread.metadata",
        threadTitle: "Metadata title",
      }),
    ];

    const metadata = extractLatestThreadMetadata(events);
    expect(metadata.threadTitle).toBe("Metadata title");
  });

  it("keeps the latest metadata title across completed and tool events", () => {
    const events: ChatEvent[] = [
      makeEvent(1, "chat.completed", { threadTitle: "Completed title" }),
      makeEvent(2, "tool.finished", {
        source: "chat.thread.metadata",
        threadTitle: "Final metadata title",
        worktreeBranch: "feat/rename-thread",
      }),
    ];

    const metadata = extractLatestThreadMetadata(events);
    expect(metadata.threadTitle).toBe("Final metadata title");
    expect(metadata.worktreeBranch).toBe("feat/rename-thread");
  });

  it("returns null when no metadata is present", () => {
    const events: ChatEvent[] = [
      makeEvent(1, "tool.started", { toolName: "Read" }),
      makeEvent(2, "tool.finished", { toolName: "Read" }),
    ];
    const metadata = extractLatestThreadMetadata(events);
    expect(metadata.threadTitle).toBeNull();
    expect(metadata.worktreeBranch).toBeNull();
  });

  it("extracts worktreeBranch from chat.completed event", () => {
    const events: ChatEvent[] = [
      makeEvent(1, "chat.completed", { worktreeBranch: "feat/new-branch" }),
    ];
    const metadata = extractLatestThreadMetadata(events);
    expect(metadata.worktreeBranch).toBe("feat/new-branch");
  });

  it("ignores tool.finished without chat.thread.metadata source", () => {
    const events: ChatEvent[] = [
      makeEvent(1, "tool.finished", {
        source: "other",
        threadTitle: "Should be ignored",
      }),
    ];
    const metadata = extractLatestThreadMetadata(events);
    expect(metadata.threadTitle).toBeNull();
  });

  it("handles empty events array", () => {
    const metadata = extractLatestThreadMetadata([]);
    expect(metadata.threadTitle).toBeNull();
    expect(metadata.worktreeBranch).toBeNull();
  });
});

describe("applyThreadTitleUpdate", () => {
  it("returns the same array when the title is unchanged", () => {
    const threads = [makeThread("Main Thread")];
    const next = applyThreadTitleUpdate(threads, "thread-1", "Main Thread");
    expect(next).toBe(threads);
  });

  it("returns updated array when title changes", () => {
    const threads = [makeThread("Main Thread")];
    const next = applyThreadTitleUpdate(threads, "thread-1", "Renamed title");
    expect(next).not.toBe(threads);
    expect(next[0].title).toBe("Renamed title");
  });

  it("returns same array when threadId is null", () => {
    const threads = [makeThread("Main Thread")];
    const next = applyThreadTitleUpdate(threads, null, "New Title");
    expect(next).toBe(threads);
  });

  it("returns same array when threadTitle is null", () => {
    const threads = [makeThread("Main Thread")];
    const next = applyThreadTitleUpdate(threads, "thread-1", null);
    expect(next).toBe(threads);
  });

  it("returns same array when thread is not found", () => {
    const threads = [makeThread("Main Thread")];
    const next = applyThreadTitleUpdate(threads, "non-existent", "New Title");
    expect(next).toBe(threads);
  });

  it("only updates the matching thread in a multi-thread list", () => {
    const threads = [makeThread("Thread A", "t-a"), makeThread("Thread B", "t-b")];
    const next = applyThreadTitleUpdate(threads, "t-b", "Updated B");
    expect(next[0].title).toBe("Thread A");
    expect(next[1].title).toBe("Updated B");
  });
});

describe("prependUniqueMessages", () => {
  it("prepends older page, dedupes overlaps, and preserves seq order", () => {
    const current = [
      makeMessage("m-3", 3),
      makeMessage("m-4", 4),
      makeMessage("m-5", 5),
    ];
    const incoming = [
      makeMessage("m-1", 1),
      makeMessage("m-2", 2),
      makeMessage("m-3", 3),
      makeMessage("m-2", 2),
    ];

    const next = prependUniqueMessages(current, incoming);

    expect(next.map((message) => message.id)).toEqual(["m-1", "m-2", "m-3", "m-4", "m-5"]);
    expect(next.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps deterministic order across sequential overlapping older pages", () => {
    const current = [
      makeMessage("m-5", 5),
      makeMessage("m-6", 6),
      makeMessage("m-7", 7),
    ];
    const page1 = [
      makeMessage("m-3", 3),
      makeMessage("m-4", 4),
      makeMessage("m-5", 5),
    ];
    const page2 = [
      makeMessage("m-1", 1),
      makeMessage("m-2", 2),
      makeMessage("m-3", 3),
      makeMessage("m-4", 4),
    ];

    const nextAfterPage1 = prependUniqueMessages(current, page1);
    const nextAfterPage2 = prependUniqueMessages(nextAfterPage1, page2);

    expect(nextAfterPage2.map((message) => message.id)).toEqual([
      "m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-7",
    ]);
    expect(nextAfterPage2.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("returns current when incoming is empty", () => {
    const current = [makeMessage("m-1", 1)];
    const result = prependUniqueMessages(current, []);
    expect(result).toBe(current);
  });

  it("handles empty current with incoming messages", () => {
    const incoming = [makeMessage("m-1", 1), makeMessage("m-2", 2)];
    const result = prependUniqueMessages([], incoming);
    expect(result.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  });
});

describe("prependUniqueEvents", () => {
  it("prepends older page, dedupes overlaps, and preserves idx order", () => {
    const current: ChatEvent[] = [
      makeEvent(3, "tool.started", { toolName: "Read" }),
      makeEvent(4, "tool.output", { toolName: "Read", output: "ok" }),
      makeEvent(5, "tool.finished", { toolName: "Read" }),
    ];
    const incoming: ChatEvent[] = [
      makeEvent(1, "chat.completed", { messageId: "msg-1" }),
      makeEvent(2, "chat.completed", { messageId: "msg-2" }),
      makeEvent(3, "tool.started", { toolName: "Read" }),
      makeEvent(2, "chat.completed", { messageId: "msg-2" }),
    ];

    const next = prependUniqueEvents(current, incoming);

    expect(next.map((event) => event.id)).toEqual(["event-1", "event-2", "event-3", "event-4", "event-5"]);
    expect(next.map((event) => event.idx)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps deterministic order across sequential overlapping older event pages", () => {
    const current: ChatEvent[] = [
      makeEvent(6, "tool.started", { toolName: "Edit" }),
      makeEvent(7, "tool.finished", { toolName: "Edit" }),
      makeEvent(8, "chat.completed", { messageId: "msg-8" }),
    ];
    const page1: ChatEvent[] = [
      makeEvent(4, "chat.completed", { messageId: "msg-4" }),
      makeEvent(5, "chat.completed", { messageId: "msg-5" }),
      makeEvent(6, "tool.started", { toolName: "Edit" }),
    ];
    const page2: ChatEvent[] = [
      makeEvent(2, "chat.completed", { messageId: "msg-2" }),
      makeEvent(3, "chat.completed", { messageId: "msg-3" }),
      makeEvent(4, "chat.completed", { messageId: "msg-4" }),
      makeEvent(5, "chat.completed", { messageId: "msg-5" }),
    ];

    const nextAfterPage1 = prependUniqueEvents(current, page1);
    const nextAfterPage2 = prependUniqueEvents(nextAfterPage1, page2);

    expect(nextAfterPage2.map((event) => event.id)).toEqual([
      "event-2", "event-3", "event-4", "event-5", "event-6", "event-7", "event-8",
    ]);
    expect(nextAfterPage2.map((event) => event.idx)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("returns current when incoming is empty", () => {
    const current: ChatEvent[] = [makeEvent(1, "chat.completed", { messageId: "m-1" })];
    const result = prependUniqueEvents(current, []);
    expect(result).toBe(current);
  });

  it("handles empty current with incoming events", () => {
    const incoming: ChatEvent[] = [
      makeEvent(1, "chat.completed", { messageId: "m-1" }),
      makeEvent(2, "chat.completed", { messageId: "m-2" }),
    ];
    const result = prependUniqueEvents([], incoming);
    expect(result.map((e) => e.idx)).toEqual([1, 2]);
  });
});

describe("mergeEventsWithCurrent", () => {
  it("returns current when local state is already ahead of queried events", () => {
    const current: ChatEvent[] = [
      makeEvent(1, "tool.started", { toolName: "Read" }),
      makeEvent(2, "tool.output", { toolName: "Read", output: "ok" }),
      makeEvent(3, "tool.finished", { toolName: "Read" }),
    ];
    const queried: ChatEvent[] = [
      makeEvent(1, "tool.started", { toolName: "Read" }),
      makeEvent(2, "tool.output", { toolName: "Read", output: "ok" }),
    ];

    const next = mergeEventsWithCurrent(queried, current);
    expect(next).toBe(current);
  });

  it("merges queried events with local events and keeps idx order", () => {
    const current: ChatEvent[] = [
      makeEvent(4, "tool.output", { toolName: "Edit", output: "ok" }),
      makeEvent(5, "tool.finished", { toolName: "Edit" }),
    ];
    const queried: ChatEvent[] = [
      makeEvent(1, "chat.completed", { messageId: "msg-1" }),
      makeEvent(2, "chat.completed", { messageId: "msg-2" }),
      makeEvent(3, "tool.started", { toolName: "Edit" }),
      makeEvent(4, "tool.output", { toolName: "Edit", output: "ok" }),
    ];

    const next = mergeEventsWithCurrent(queried, current);
    expect(next.map((event) => event.idx)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns current when both arrays are identical", () => {
    const events: ChatEvent[] = [
      makeEvent(1, "chat.completed", { messageId: "m-1" }),
      makeEvent(2, "chat.completed", { messageId: "m-2" }),
    ];
    const result = mergeEventsWithCurrent([...events], events);
    expect(result).toBe(events);
  });

  it("handles empty current array", () => {
    const queried: ChatEvent[] = [
      makeEvent(1, "chat.completed", { messageId: "m-1" }),
    ];
    const result = mergeEventsWithCurrent(queried, []);
    expect(result.map((e) => e.idx)).toEqual([1]);
  });

  it("handles empty queried array", () => {
    const current: ChatEvent[] = [
      makeEvent(1, "chat.completed", { messageId: "m-1" }),
    ];
    const result = mergeEventsWithCurrent([], current);
    expect(result).toBe(current);
  });

  it("adds unique events from current that are not in queried", () => {
    const current: ChatEvent[] = [
      makeEvent(3, "tool.finished", { toolName: "Read" }),
      makeEvent(5, "chat.completed", { messageId: "m-5" }),
    ];
    const queried: ChatEvent[] = [
      makeEvent(1, "chat.completed", { messageId: "m-1" }),
      makeEvent(2, "chat.completed", { messageId: "m-2" }),
      makeEvent(3, "tool.finished", { toolName: "Read" }),
      makeEvent(4, "tool.started", { toolName: "Edit" }),
    ];

    const result = mergeEventsWithCurrent(queried, current);
    expect(result.map((e) => e.idx)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("deriveSelectedThreadUiState", () => {
  it("returns running and keeps composer enabled after refresh for an active selected thread", () => {
    const state = deriveSelectedThreadUiState({
      selectedThreadId: "thread-1",
      threads: [{ ...makeThread("Main Thread"), active: true }],
      events: [],
      sendingMessage: false,
      waitingAssistant: { threadId: "thread-1", afterIdx: 10 },
    });

    expect(state.selectedThreadUiStatus).toBe("running");
    expect(state.composerDisabled).toBe(false);
  });

  it("returns waiting_approval over running when a permission gate is pending", () => {
    const state = deriveSelectedThreadUiState({
      selectedThreadId: "thread-1",
      threads: [{ ...makeThread("Main Thread"), active: true }],
      events: [makeEvent(1, "permission.requested", { requestId: "perm-1", toolName: "Bash" })],
      sendingMessage: false,
      waitingAssistant: { threadId: "thread-1", afterIdx: 0 },
    });

    expect(state.selectedThreadUiStatus).toBe("waiting_approval");
    expect(state.composerDisabled).toBe(false);
  });

  it("returns review_plan over running once a pending plan run has completed", () => {
    const state = deriveSelectedThreadUiState({
      selectedThreadId: "thread-1",
      threads: [{ ...makeThread("Main Thread"), active: true }],
      events: [
        makeEvent(1, "plan.created", { content: "Plan body", filePath: "/tmp/.claude/plans/plan.md" }),
        makeEvent(2, "chat.completed", {}),
      ],
      sendingMessage: false,
      waitingAssistant: { threadId: "thread-1", afterIdx: 0 },
    });

    expect(state.selectedThreadUiStatus).toBe("review_plan");
    expect(state.composerDisabled).toBe(false);
  });

  it("disables the composer only while a send request is in flight", () => {
    const state = deriveSelectedThreadUiState({
      selectedThreadId: "thread-1",
      threads: [{ ...makeThread("Main Thread"), active: true }],
      events: [],
      sendingMessage: true,
      waitingAssistant: { threadId: "thread-1", afterIdx: 0 },
    });

    expect(state.selectedThreadUiStatus).toBe("running");
    expect(state.composerDisabled).toBe(true);
  });
});

describe("applyThreadModeUpdate", () => {
  it("updates only the matching thread mode", () => {
    const threads = [makeThread("Thread A", "t-a"), makeThread("Thread B", "t-b")];
    const next = applyThreadModeUpdate(threads, "t-b", "plan");
    expect(next[0].mode).toBe("default");
    expect(next[1].mode).toBe("plan");
  });

  it("returns same array when mode is unchanged", () => {
    const threads = [makeThread("Thread A", "t-a")];
    const next = applyThreadModeUpdate(threads, "t-a", "default");
    expect(next).toBe(threads);
  });
});

describe("snapshot seed decision helpers", () => {
  it("returns no-thread-or-snapshot when selected thread is null", () => {
    const decision = resolveSnapshotSeedDecision({
      selectedThreadId: null,
      queriedThreadSnapshot: makeSnapshot(),
      threadChanged: false,
      lastAppliedSnapshotKey: null,
    });

    expect(decision).toEqual({
      shouldApply: false,
      reason: "no-thread-or-snapshot",
      snapshotKey: null,
    });
  });

  it("returns no-thread-or-snapshot when snapshot is temporarily unavailable", () => {
    const decision = resolveSnapshotSeedDecision({
      selectedThreadId: "thread-1",
      queriedThreadSnapshot: undefined,
      threadChanged: false,
      lastAppliedSnapshotKey: "existing-snapshot-key",
    });

    expect(decision).toEqual({
      shouldApply: false,
      reason: "no-thread-or-snapshot",
      snapshotKey: null,
    });
  });

  it("skips same snapshot key for same thread", () => {
    const snapshot = makeSnapshot();
    const snapshotKey = buildSnapshotKey(snapshot);

    const decision = resolveSnapshotSeedDecision({
      selectedThreadId: "thread-1",
      queriedThreadSnapshot: snapshot,
      threadChanged: false,
      lastAppliedSnapshotKey: snapshotKey,
    });

    expect(decision).toEqual({
      shouldApply: false,
      reason: "same-snapshot-key",
      snapshotKey,
    });
  });

  it("applies on thread change even with same lengths", () => {
    const snapshotA = makeSnapshot({ newestSeq: 1, newestIdx: 100 });
    const snapshotB = makeSnapshot({ newestSeq: 2, newestIdx: 110 });

    const decision = resolveSnapshotSeedDecision({
      selectedThreadId: "thread-2",
      queriedThreadSnapshot: snapshotB,
      threadChanged: true,
      lastAppliedSnapshotKey: buildSnapshotKey(snapshotA),
    });

    expect(decision.shouldApply).toBe(true);
    expect(decision.reason).toBe("thread-changed");
    expect(decision.snapshotKey).toBe(buildSnapshotKey(snapshotB));
  });

  it("submit_message_does_not_force_immediate_snapshot_invalidation", () => {
    expect(shouldInvalidateSnapshotImmediatelyAfterSubmit()).toBe(false);
  });
});

function createStateSetter<T>(state: { current: T }) {
  return (value: T | ((current: T) => T)) => {
    state.current = typeof value === "function"
      ? (value as (current: T) => T)(state.current)
      : value;
  };
}

function createRef<T>(value: T) {
  return { current: value };
}

describe("applySnapshotSeed", () => {
  it("applies snapshot events and messages to state setters", () => {
    const snapshot = makeSnapshot({ newestSeq: 1, newestIdx: 10 });
    const messagesState = { current: [] as ChatMessage[] };
    const eventsState = { current: [] as ChatEvent[] };
    const threadsState = { current: [makeThread("Original title")] };
    const seenEventIdsByThreadRef = createRef(new Map<string, Set<string>>());
    const lastEventIdxByThreadRef = createRef(new Map<string, number>());

    applySnapshotSeed({
      snapshot,
      selectedThreadId: "thread-1",
      selectedWorktreeId: null,
      setMessages: createStateSetter(messagesState),
      setEvents: createStateSetter(eventsState),
      setThreads: createStateSetter(threadsState),
      seenEventIdsByThreadRef,
      lastEventIdxByThreadRef,
      activeThreadIdRef: createRef("thread-1"),
      mode: "merge",
    });

    expect(messagesState.current.length).toBeGreaterThan(0);
    expect(eventsState.current.length).toBeGreaterThan(0);
  });

  it("still applies metadata updates from snapshot", () => {
    const metadataEvent = makeEvent(8, "chat.completed", {
      messageId: "m-1",
      threadTitle: "Updated title",
      worktreeBranch: "feat/branch",
    });
    const snapshot = {
      ...makeSnapshot({ newestSeq: 1, newestIdx: 8 }),
      events: [metadataEvent],
    };
    const threadsState = { current: [makeThread("Original title")] };
    const branchUpdates: string[] = [];

    applySnapshotSeed({
      snapshot,
      selectedThreadId: "thread-1",
      selectedWorktreeId: "wt-1",
      setMessages: createStateSetter({ current: [] as ChatMessage[] }),
      setEvents: createStateSetter({ current: [] as ChatEvent[] }),
      setThreads: createStateSetter(threadsState),
      seenEventIdsByThreadRef: createRef(new Map()),
      lastEventIdxByThreadRef: createRef(new Map()),
      activeThreadIdRef: createRef("thread-1"),
      onBranchRenamed: (_worktreeId, branch) => branchUpdates.push(branch),
      mode: "merge",
    });

    expect(threadsState.current[0]?.title).toBe("Updated title");
    expect(branchUpdates).toEqual(["feat/branch"]);
  });
});
