import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatThread } from "@codesymphony/shared-types";
import {
  applyThreadTitleUpdate,
  buildAutoBackfillLaunchKey,
  buildAutoBackfillSnapshotKey,
  extractLatestThreadMetadata,
  mergeEventsWithCurrent,
  prependUniqueEvents,
  prependUniqueMessages,
  resolveHydrationBackfillPolicy,
  resolveSnapshotSeedDecision,
  runAutoBackfillLoop,
  shouldAutoBackfillOnHydration,
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
    titleEditedManually: false,
    claudeSessionId: null,
    active: false,
    createdAt: "2026-02-28T00:00:00.000Z",
    updatedAt: "2026-02-28T00:00:00.000Z",
  };
}

function makeMessage(id: string, seq: number) {
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
  coverage?: {
    eventsStatus?: "complete" | "needs_backfill" | "capped";
    recommendedBackfill?: boolean;
    nextBeforeIdx?: number | null;
  };
  watermarks?: {
    newestSeq?: number;
    newestIdx?: number;
  };
}) {
  return {
    messages: {
      data: [makeMessage("m-1", 1)],
      pageInfo: {
        hasMoreOlder: false,
        nextBeforeSeq: null,
        oldestSeq: 1,
        newestSeq: 1,
      },
    },
    events: {
      data: [makeEvent(1, "chat.completed", { messageId: "m-1" })],
      pageInfo: {
        hasMoreOlder: false,
        nextBeforeIdx: null,
        oldestIdx: 1,
        newestIdx: 1,
      },
    },
    watermarks: {
      newestSeq: overrides?.watermarks?.newestSeq ?? 1,
      newestIdx: overrides?.watermarks?.newestIdx ?? 1,
    },
    coverage: {
      eventsStatus: overrides?.coverage?.eventsStatus ?? "complete",
      recommendedBackfill: overrides?.coverage?.recommendedBackfill ?? false,
      nextBeforeIdx: overrides?.coverage?.nextBeforeIdx ?? null,
    },
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

  it("snapshot_seed_skips_same_snapshot_key_for_same_thread", () => {
    const snapshot = makeSnapshot({
      coverage: {
        eventsStatus: "needs_backfill",
        recommendedBackfill: true,
        nextBeforeIdx: 120,
      },
    });
    const snapshotKey = buildAutoBackfillSnapshotKey(snapshot);

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

  it("snapshot_seed_applies_on_thread_change_even_with_same_lengths", () => {
    const snapshotA = makeSnapshot({
      coverage: {
        eventsStatus: "needs_backfill",
        recommendedBackfill: true,
        nextBeforeIdx: 120,
      },
      watermarks: {
        newestSeq: 1,
        newestIdx: 100,
      },
    });
    const snapshotB = makeSnapshot({
      coverage: {
        eventsStatus: "needs_backfill",
        recommendedBackfill: true,
        nextBeforeIdx: 120,
      },
      watermarks: {
        newestSeq: 2,
        newestIdx: 110,
      },
    });

    expect(snapshotA.messages.data).toHaveLength(snapshotB.messages.data.length);
    expect(snapshotA.events.data).toHaveLength(snapshotB.events.data.length);

    const decision = resolveSnapshotSeedDecision({
      selectedThreadId: "thread-2",
      queriedThreadSnapshot: snapshotB,
      threadChanged: true,
      lastAppliedSnapshotKey: buildAutoBackfillSnapshotKey(snapshotA),
    });

    expect(decision.shouldApply).toBe(true);
    expect(decision.reason).toBe("thread-changed");
    expect(decision.snapshotKey).toBe(buildAutoBackfillSnapshotKey(snapshotB));
  });

  it("submit_message_does_not_force_immediate_snapshot_invalidation", () => {
    expect(shouldInvalidateSnapshotImmediatelyAfterSubmit()).toBe(false);
  });
});

describe("auto-backfill hydration helpers", () => {
  it("defaults hydration backfill policy to manual", () => {
    expect(resolveHydrationBackfillPolicy(undefined)).toBe("manual");
    expect(resolveHydrationBackfillPolicy("manual")).toBe("manual");
    expect(resolveHydrationBackfillPolicy("auto")).toBe("auto");
  });

  it("only enables auto-backfill when timeline repair is needed and older events exist", () => {
    const needsBackfillSnapshot = makeSnapshot({
      coverage: {
        eventsStatus: "needs_backfill",
        recommendedBackfill: true,
        nextBeforeIdx: 120,
      },
    });

    expect(shouldAutoBackfillOnHydration(needsBackfillSnapshot, true)).toBe(true);
    expect(shouldAutoBackfillOnHydration(needsBackfillSnapshot, false)).toBe(false);
    expect(shouldAutoBackfillOnHydration(makeSnapshot(), true)).toBe(false);
    expect(shouldAutoBackfillOnHydration(makeSnapshot(), false)).toBe(false);
  });

  it("builds a stable snapshot key from watermarks and coverage", () => {
    const snapshotA = makeSnapshot({
      coverage: {
        eventsStatus: "needs_backfill",
        recommendedBackfill: true,
        nextBeforeIdx: 220,
      },
    });
    const snapshotB = makeSnapshot({
      coverage: {
        eventsStatus: "needs_backfill",
        recommendedBackfill: true,
        nextBeforeIdx: 220,
      },
    });
    const snapshotC = makeSnapshot({
      coverage: {
        eventsStatus: "capped",
        recommendedBackfill: true,
        nextBeforeIdx: 220,
      },
    });

    expect(buildAutoBackfillSnapshotKey(snapshotA)).toBe(buildAutoBackfillSnapshotKey(snapshotB));
    expect(buildAutoBackfillSnapshotKey(snapshotA)).not.toBe(buildAutoBackfillSnapshotKey(snapshotC));
  });

  it("produces different keys for different watermarks", () => {
    const a = makeSnapshot({ watermarks: { newestSeq: 1, newestIdx: 1 } });
    const b = makeSnapshot({ watermarks: { newestSeq: 2, newestIdx: 5 } });
    expect(buildAutoBackfillSnapshotKey(a)).not.toBe(buildAutoBackfillSnapshotKey(b));
  });

  it("builds stable auto-backfill launch keys from snapshot transition inputs", () => {
    const snapshot = makeSnapshot({
      coverage: {
        eventsStatus: "needs_backfill",
        recommendedBackfill: true,
        nextBeforeIdx: 220,
      },
      watermarks: {
        newestSeq: 4,
        newestIdx: 25,
      },
    });
    const snapshotKey = buildAutoBackfillSnapshotKey(snapshot);

    const launchA = buildAutoBackfillLaunchKey({
      snapshotKey,
      coverageNextBeforeIdx: 220,
    });
    const launchB = buildAutoBackfillLaunchKey({
      snapshotKey,
      coverageNextBeforeIdx: 220,
    });
    const launchC = buildAutoBackfillLaunchKey({
      snapshotKey,
      coverageNextBeforeIdx: 180,
    });

    expect(launchA).toBe(launchB);
    expect(launchA).not.toBe(launchC);
  });

  it("resets per-thread launch cap count when snapshot key changes", () => {
    const snapshotA = makeSnapshot({
      coverage: {
        eventsStatus: "needs_backfill",
        recommendedBackfill: true,
        nextBeforeIdx: 220,
      },
      watermarks: {
        newestSeq: 4,
        newestIdx: 25,
      },
    });
    const snapshotB = makeSnapshot({
      coverage: {
        eventsStatus: "needs_backfill",
        recommendedBackfill: true,
        nextBeforeIdx: 140,
      },
      watermarks: {
        newestSeq: 5,
        newestIdx: 41,
      },
    });

    const keyA = buildAutoBackfillSnapshotKey(snapshotA);
    const keyB = buildAutoBackfillSnapshotKey(snapshotB);
    expect(keyA).not.toBe(keyB);

    const launchA = buildAutoBackfillLaunchKey({
      snapshotKey: keyA,
      coverageNextBeforeIdx: 220,
    });
    const launchB = buildAutoBackfillLaunchKey({
      snapshotKey: keyB,
      coverageNextBeforeIdx: 140,
    });

    expect(launchA).not.toBe(launchB);
  });

  it("stops auto-backfill loop when auto-backfill is no longer allowed", async () => {
    let beforeIdx: number | null = 120;
    let incomplete = true;

    const outcome = await runAutoBackfillLoop({
      maxPages: 4,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => false,
      isAutoBackfillAllowed: () => incomplete,
      getBeforeIdx: () => beforeIdx,
      loadOlderHistoryPage: async () => {
        beforeIdx = 80;
        incomplete = false;
        return {
          cycleId: 1,
          requestId: "auto-1",
          completionReason: "applied",
          messagesAdded: 0,
          eventsAdded: 25,
          estimatedRenderableGrowth: true,
          semanticBoundaryDetected: false,
          semanticBoundary: null,
        };
      },
      isTimelineIncomplete: () => incomplete,
    });

    expect(outcome).toEqual({ pagesLoaded: 1, stopReason: "timeline-complete", semanticBoundary: null });
  });

  it("stops auto-backfill loop before page load when auto-backfill disallows immediately", async () => {
    const loadOlderHistoryPage = () => Promise.resolve(undefined as never);

    const outcome = await runAutoBackfillLoop({
      maxPages: 4,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => false,
      isAutoBackfillAllowed: () => false,
      getBeforeIdx: () => 120,
      loadOlderHistoryPage,
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({ pagesLoaded: 0, stopReason: "timeline-complete", semanticBoundary: null });
  });

  it("caps auto-backfill loop by max pages", async () => {
    let beforeIdx: number | null = 500;
    let calls = 0;

    const outcome = await runAutoBackfillLoop({
      maxPages: 2,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => false,
      isAutoBackfillAllowed: () => true,
      getBeforeIdx: () => beforeIdx,
      loadOlderHistoryPage: async () => {
        calls += 1;
        beforeIdx = beforeIdx == null ? null : beforeIdx - 50;
        return {
          cycleId: 1,
          requestId: `auto-${calls}`,
          completionReason: "applied",
          messagesAdded: 0,
          eventsAdded: 10,
          estimatedRenderableGrowth: true,
          semanticBoundaryDetected: false,
          semanticBoundary: null,
        };
      },
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({ pagesLoaded: 2, stopReason: "max-pages", semanticBoundary: null });
  });

  it("stops auto-backfill loop on no progress", async () => {
    let beforeIdx = 300;

    const outcome = await runAutoBackfillLoop({
      maxPages: 4,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => false,
      isAutoBackfillAllowed: () => true,
      getBeforeIdx: () => beforeIdx,
      loadOlderHistoryPage: async () => {
        beforeIdx = 300;
        return {
          cycleId: 7,
          requestId: "auto-stall",
          completionReason: "applied",
          messagesAdded: 0,
          eventsAdded: 0,
          estimatedRenderableGrowth: false,
          semanticBoundaryDetected: false,
          semanticBoundary: null,
        };
      },
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({ pagesLoaded: 1, stopReason: "no-progress", semanticBoundary: null });
  });

  it("stops auto-backfill loop when cursor does not monotonically decrease", async () => {
    let beforeIdx = 300;

    const outcome = await runAutoBackfillLoop({
      maxPages: 4,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => false,
      isAutoBackfillAllowed: () => true,
      getBeforeIdx: () => beforeIdx,
      loadOlderHistoryPage: async () => {
        beforeIdx = 320;
        return {
          cycleId: 8,
          requestId: "auto-non-monotonic",
          completionReason: "applied",
          messagesAdded: 0,
          eventsAdded: 3,
          estimatedRenderableGrowth: true,
          semanticBoundaryDetected: false,
          semanticBoundary: null,
        };
      },
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({ pagesLoaded: 1, stopReason: "no-progress", semanticBoundary: null });
  });

  it("stops auto-backfill loop when thread is switched", async () => {
    let firstCall = true;
    let beforeIdx = 100;

    const outcome = await runAutoBackfillLoop({
      maxPages: 4,
      shouldAbort: () => {
        if (firstCall) {
          firstCall = false;
          return false;
        }
        return true;
      },
      isLoadingOlderHistory: () => false,
      isAutoBackfillAllowed: () => true,
      getBeforeIdx: () => beforeIdx,
      loadOlderHistoryPage: async () => {
        beforeIdx = 80;
        return {
          cycleId: 9,
          requestId: "auto-switch",
          completionReason: "applied",
          messagesAdded: 0,
          eventsAdded: 15,
          estimatedRenderableGrowth: true,
          semanticBoundaryDetected: false,
          semanticBoundary: null,
        };
      },
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({ pagesLoaded: 1, stopReason: "abort", semanticBoundary: null });
  });

  it("stops when isLoadingOlderHistory returns true", async () => {
    const outcome = await runAutoBackfillLoop({
      maxPages: 4,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => true,
      isAutoBackfillAllowed: () => true,
      getBeforeIdx: () => 100,
      loadOlderHistoryPage: async () => undefined as never,
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({ pagesLoaded: 0, stopReason: "loading-older-history", semanticBoundary: null });
  });

  it("stops when getBeforeIdx returns null", async () => {
    const outcome = await runAutoBackfillLoop({
      maxPages: 4,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => false,
      isAutoBackfillAllowed: () => true,
      getBeforeIdx: () => null,
      loadOlderHistoryPage: async () => undefined as never,
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({ pagesLoaded: 0, stopReason: "no-more-events", semanticBoundary: null });
  });

  it("stops when loadOlderHistoryPage returns void", async () => {
    const outcome = await runAutoBackfillLoop({
      maxPages: 4,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => false,
      isAutoBackfillAllowed: () => true,
      getBeforeIdx: () => 50,
      loadOlderHistoryPage: async () => undefined,
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({ pagesLoaded: 1, stopReason: "no-result", semanticBoundary: null });
  });

  it("stops when completionReason is not applied", async () => {
    const outcome = await runAutoBackfillLoop({
      maxPages: 4,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => false,
      isAutoBackfillAllowed: () => true,
      getBeforeIdx: () => 50,
      loadOlderHistoryPage: async () => ({
        cycleId: 1,
        requestId: "auto-1",
        completionReason: "thread-changed",
        messagesAdded: 0,
        eventsAdded: 0,
        estimatedRenderableGrowth: false,
        semanticBoundaryDetected: false,
        semanticBoundary: null,
      }),
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({ pagesLoaded: 1, stopReason: "completion-reason", semanticBoundary: null });
  });

  it("stops auto-backfill loop on semantic boundary when enabled", async () => {
    let beforeIdx: number | null = 120;

    const outcome = await runAutoBackfillLoop({
      maxPages: 4,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => false,
      isAutoBackfillAllowed: () => true,
      stopOnSemanticBoundary: true,
      getBeforeIdx: () => beforeIdx,
      loadOlderHistoryPage: async () => {
        beforeIdx = 90;
        return {
          cycleId: 11,
          requestId: "auto-semantic-stop",
          completionReason: "applied",
          messagesAdded: 0,
          eventsAdded: 8,
          estimatedRenderableGrowth: true,
          semanticBoundaryDetected: true,
          semanticBoundary: {
            kind: "plan-file-output",
            eventId: "event-120",
            eventIdx: 120,
            eventType: "plan.created",
          },
        };
      },
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({
      pagesLoaded: 1,
      stopReason: "semantic-boundary-detected",
      semanticBoundary: {
        kind: "plan-file-output",
        eventId: "event-120",
        eventIdx: 120,
        eventType: "plan.created",
      },
    });
  });

  it("does not stop on semantic boundary when disabled", async () => {
    let beforeIdx: number | null = 120;
    let page = 0;

    const outcome = await runAutoBackfillLoop({
      maxPages: 2,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => false,
      isAutoBackfillAllowed: () => true,
      stopOnSemanticBoundary: false,
      getBeforeIdx: () => beforeIdx,
      loadOlderHistoryPage: async () => {
        page += 1;
        if (page === 1) {
          beforeIdx = 80;
          return {
            cycleId: 12,
            requestId: "auto-semantic-disabled-1",
            completionReason: "applied",
            messagesAdded: 0,
            eventsAdded: 6,
            estimatedRenderableGrowth: true,
            semanticBoundaryDetected: true,
            semanticBoundary: {
              kind: "explore-activity",
              eventId: "event-95",
              eventIdx: 95,
              eventType: "tool.finished",
            },
          };
        }

        beforeIdx = 40;
        return {
          cycleId: 12,
          requestId: "auto-semantic-disabled-2",
          completionReason: "applied",
          messagesAdded: 0,
          eventsAdded: 5,
          estimatedRenderableGrowth: true,
          semanticBoundaryDetected: false,
          semanticBoundary: null,
        };
      },
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({ pagesLoaded: 2, stopReason: "max-pages", semanticBoundary: null });
  });
});
