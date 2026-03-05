import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import { computeMessageAnchorIdxById, useWorkspaceTimeline, type TimelineRefs } from "./workspace-timeline";

function makeMessage(id: string, seq: number, role: "assistant" | "user" = "assistant"): ChatMessage {
  return {
    id,
    threadId: "thread-1",
    seq,
    role,
    content: id,
    attachments: [],
    createdAt: "2026-03-01T00:00:00.000Z",
  };
}

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
    createdAt: "2026-03-01T00:00:00.000Z",
  };
}

type TimelineHarnessProps = {
  messages: ChatMessage[];
  events: ChatEvent[];
  selectedThreadId: string | null;
  refs: TimelineRefs;
  options?: { semanticHydrationInProgress?: boolean };
  onResult: (result: ReturnType<typeof useWorkspaceTimeline>) => void;
};

function TimelineHarness({ messages, events, selectedThreadId, refs, options, onResult }: TimelineHarnessProps) {
  const result = useWorkspaceTimeline(messages, events, selectedThreadId, refs, options);
  onResult(result);
  return null;
}

function createTimelineRefs(): TimelineRefs {
  return {
    streamingMessageIds: new Set<string>(),
    stickyRawFallbackMessageIds: new Set<string>(),
    renderDecisionByMessageId: new Map<string, string>(),
    loggedOrphanEventIdsByThread: new Map<string, Set<string>>(),
    loggedFirstInsertOrderByMessageId: new Set<string>(),
  };
}

describe("computeMessageAnchorIdxById", () => {
  it("infers anchors for messages whose early events were not loaded", () => {
    const messages = [
      makeMessage("m-0", 0, "user"),
      makeMessage("m-1", 1),
      makeMessage("m-2", 2),
    ];

    const firstMessageEventIdxById = new Map<string, number>([
      ["m-1", 125],
      ["m-2", 401],
    ]);

    const anchors = computeMessageAnchorIdxById(
      messages,
      firstMessageEventIdxById,
      new Map<string, number>(),
    );

    expect(anchors.get("m-0")).toBe(0);
    expect(anchors.get("m-1")).toBe(125);
    expect(anchors.get("m-2")).toBe(401);
  });

  it("interpolates anchors between known message anchors", () => {
    const messages = [
      makeMessage("m-1", 1),
      makeMessage("m-2", 2),
      makeMessage("m-3", 3),
      makeMessage("m-4", 4),
    ];

    const firstMessageEventIdxById = new Map<string, number>([
      ["m-1", 100],
      ["m-4", 103],
    ]);

    const anchors = computeMessageAnchorIdxById(
      messages,
      firstMessageEventIdxById,
      new Map<string, number>(),
    );

    expect(anchors.get("m-1")).toBe(100);
    expect(anchors.get("m-2")).toBe(101);
    expect(anchors.get("m-3")).toBe(102);
    expect(anchors.get("m-4")).toBe(103);
  });

  it("uses completed-message anchors when message.delta anchors are missing", () => {
    const messages = [
      makeMessage("m-1", 1),
      makeMessage("m-2", 2),
      makeMessage("m-3", 3),
    ];

    const completedEventIdxByMessageId = new Map<string, number>([
      ["m-2", 50],
    ]);

    const anchors = computeMessageAnchorIdxById(
      messages,
      new Map<string, number>(),
      completedEventIdxByMessageId,
    );

    expect(anchors.get("m-1")).toBe(49);
    expect(anchors.get("m-2")).toBe(50);
    expect(anchors.get("m-3")).toBe(51);
  });

  it("falls back to sequence when no anchors exist in events", () => {
    const messages = [
      makeMessage("m-7", 7),
      makeMessage("m-8", 8),
      makeMessage("m-9", 9),
    ];

    const anchors = computeMessageAnchorIdxById(
      messages,
      new Map<string, number>(),
      new Map<string, number>(),
    );

    expect(anchors.get("m-7")).toBe(7);
    expect(anchors.get("m-8")).toBe(8);
    expect(anchors.get("m-9")).toBe(9);
  });
});

describe("useWorkspaceTimeline coverage metadata", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
  });

  it("returns stable shape with coverage flag on partial history inputs", () => {
    const refs = createTimelineRefs();
    const messages = [
      {
        ...makeMessage("assistant-1", 1, "assistant"),
        content: "Partial timeline sample",
      },
    ];
    const events: ChatEvent[] = [
      makeEvent(10, "tool.started", { toolName: "Read", toolUseId: "tool-1" }),
      makeEvent(11, "message.delta", {
        messageId: "assistant-1",
        role: "assistant",
        delta: "Partial",
      }),
    ];

    let timelineResult: ReturnType<typeof useWorkspaceTimeline> | undefined;

    act(() => {
      root.render(createElement(TimelineHarness, {
        messages,
        events,
        selectedThreadId: "thread-1",
        refs,
        onResult: (result) => {
          timelineResult = result;
        },
      }));
    });

    expect(timelineResult).toBeDefined();
    if (!timelineResult) {
      throw new Error("Expected timeline result");
    }

    expect(typeof timelineResult.hasIncompleteCoverage).toBe("boolean");
    expect(Array.isArray(timelineResult.items)).toBe(true);
    expect(timelineResult.items.length).toBeGreaterThan(0);
  });

  it("marks coverage complete for fully anchored assistant deltas", () => {
    const refs = createTimelineRefs();
    const messages = [
      makeMessage("assistant-1", 1, "assistant"),
    ];
    const events: ChatEvent[] = [
      makeEvent(12, "message.delta", {
        messageId: "assistant-1",
        role: "assistant",
        delta: "Hello",
      }),
      makeEvent(13, "message.delta", {
        messageId: "assistant-1",
        role: "assistant",
        delta: " world",
      }),
      makeEvent(14, "chat.completed", {
        messageId: "assistant-1",
      }),
    ];

    let timelineResult: ReturnType<typeof useWorkspaceTimeline> | undefined;

    act(() => {
      root.render(createElement(TimelineHarness, {
        messages,
        events,
        selectedThreadId: "thread-1",
        refs,
        onResult: (result) => {
          timelineResult = result;
        },
      }));
    });

    expect(timelineResult).toBeDefined();
    if (!timelineResult) {
      throw new Error("Expected timeline result");
    }

    expect(timelineResult.hasIncompleteCoverage).toBe(false);
  });
});
