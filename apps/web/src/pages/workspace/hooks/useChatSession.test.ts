import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatThread } from "@codesymphony/shared-types";
import {
  applyThreadTitleUpdate,
  buildAutoBackfillSnapshotKey,
  extractLatestThreadMetadata,
  mergeEventsWithCurrent,
  prependUniqueEvents,
  prependUniqueMessages,
  runAutoBackfillLoop,
  shouldAutoBackfillOnHydration,
} from "./useChatSession";

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

function makeThread(title: string): ChatThread {
  return {
    id: "thread-1",
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
      newestSeq: 1,
      newestIdx: 1,
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
      "m-1",
      "m-2",
      "m-3",
      "m-4",
      "m-5",
      "m-6",
      "m-7",
    ]);
    expect(nextAfterPage2.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
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
      "event-2",
      "event-3",
      "event-4",
      "event-5",
      "event-6",
      "event-7",
      "event-8",
    ]);
    expect(nextAfterPage2.map((event) => event.idx)).toEqual([2, 3, 4, 5, 6, 7, 8]);
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
});

describe("auto-backfill hydration helpers", () => {
  it("enables auto-backfill when snapshot coverage is incomplete", () => {
    const needsBackfillSnapshot = makeSnapshot({
      coverage: {
        eventsStatus: "needs_backfill",
        recommendedBackfill: true,
        nextBeforeIdx: 120,
      },
    });

    expect(shouldAutoBackfillOnHydration(needsBackfillSnapshot, false)).toBe(true);
    expect(shouldAutoBackfillOnHydration(makeSnapshot(), true)).toBe(true);
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

  it("stops auto-backfill loop when timeline becomes complete", async () => {
    let beforeIdx: number | null = 120;
    let incomplete = true;

    const outcome = await runAutoBackfillLoop({
      maxPages: 4,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => false,
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
        };
      },
      isTimelineIncomplete: () => incomplete,
    });

    expect(outcome).toEqual({ pagesLoaded: 1, stopReason: "timeline-complete" });
  });

  it("caps auto-backfill loop by max pages", async () => {
    let beforeIdx: number | null = 500;
    let calls = 0;

    const outcome = await runAutoBackfillLoop({
      maxPages: 2,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => false,
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
        };
      },
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({ pagesLoaded: 2, stopReason: "max-pages" });
  });

  it("stops auto-backfill loop on no progress", async () => {
    const beforeIdx = 300;

    const outcome = await runAutoBackfillLoop({
      maxPages: 4,
      shouldAbort: () => false,
      isLoadingOlderHistory: () => false,
      getBeforeIdx: () => beforeIdx,
      loadOlderHistoryPage: async () => ({
        cycleId: 7,
        requestId: "auto-stall",
        completionReason: "applied",
        messagesAdded: 0,
        eventsAdded: 0,
        estimatedRenderableGrowth: false,
      }),
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({ pagesLoaded: 1, stopReason: "no-progress" });
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
        };
      },
      isTimelineIncomplete: () => true,
    });

    expect(outcome).toEqual({ pagesLoaded: 1, stopReason: "token-or-thread-changed" });
  });
});
