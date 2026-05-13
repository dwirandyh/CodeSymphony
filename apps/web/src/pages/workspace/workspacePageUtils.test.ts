import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatTimelineItem } from "@codesymphony/shared-types";
import { deriveWorkingStatus, shouldShowThinkingPlaceholder } from "./workspacePageUtils";

function makeMessageTimelineItem(role: "user" | "assistant", id: string): ChatTimelineItem {
  return {
    kind: "message",
    message: {
      id,
      threadId: "thread-1",
      seq: 1,
      role,
      content: role === "assistant" ? "Hello" : "Hi",
      attachments: [],
      createdAt: "2026-01-01T00:00:00Z",
    },
    renderHint: "markdown",
    isCompleted: role === "assistant",
  };
}

function makeTerminalEvent(type: "chat.completed" | "chat.failed", createdAt: string): ChatEvent {
  return {
    id: `${type}-1`,
    threadId: "thread-1",
    idx: 2,
    type,
    payload: {},
    createdAt,
  };
}

describe("shouldShowThinkingPlaceholder", () => {
  it("shows placeholder while running before an assistant timeline item exists", () => {
    expect(shouldShowThinkingPlaceholder({
      selectedThreadUiStatus: "running",
      isWaitingForUserGate: false,
      timelineItems: [makeMessageTimelineItem("user", "user-1")],
    })).toBe(true);
  });

  it("keeps placeholder while running after an assistant timeline item exists", () => {
    expect(shouldShowThinkingPlaceholder({
      selectedThreadUiStatus: "running",
      isWaitingForUserGate: false,
      timelineItems: [
        makeMessageTimelineItem("user", "user-1"),
        makeMessageTimelineItem("assistant", "assistant-1"),
      ],
    })).toBe(true);
  });

  it("hides placeholder outside running state or while waiting for user", () => {
    expect(shouldShowThinkingPlaceholder({
      selectedThreadUiStatus: "idle",
      isWaitingForUserGate: false,
      timelineItems: [makeMessageTimelineItem("user", "user-1")],
    })).toBe(false);

    expect(shouldShowThinkingPlaceholder({
      selectedThreadUiStatus: "running",
      isWaitingForUserGate: true,
      timelineItems: [makeMessageTimelineItem("user", "user-1")],
    })).toBe(false);
  });

  it("keeps completed working status visible after a terminal event", () => {
    expect(shouldShowThinkingPlaceholder({
      selectedThreadUiStatus: "idle",
      isWaitingForUserGate: false,
      timelineItems: [makeMessageTimelineItem("user", "user-1")],
      workingStatus: {
        label: "Working",
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:00:08Z",
        state: "completed",
      },
    })).toBe(true);
  });
});

describe("deriveWorkingStatus", () => {
  it("uses Waiting for response before assistant activity starts", () => {
    expect(deriveWorkingStatus({
      selectedThreadUiStatus: "running",
      timelineItems: [makeMessageTimelineItem("user", "user-1")],
    })).toEqual({
      label: "Waiting for response",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: null,
      state: "running",
    });
  });

  it("uses Editing when the latest running item is an edited diff", () => {
    expect(deriveWorkingStatus({
      selectedThreadUiStatus: "running",
      timelineItems: [
        makeMessageTimelineItem("user", "user-1"),
        {
          kind: "edited-diff",
          id: "edit-1",
          eventId: "event-1",
          status: "running",
          diffKind: "actual",
          changedFiles: ["src/app.ts"],
          diff: "",
          diffTruncated: false,
          additions: 1,
          deletions: 0,
          createdAt: "2026-01-01T00:00:03Z",
        },
      ],
    })).toEqual({
      label: "Editing",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: null,
      state: "running",
    });
  });

  it("uses a completed Worked status with terminal duration", () => {
    expect(deriveWorkingStatus({
      events: [makeTerminalEvent("chat.completed", "2026-01-01T00:00:08Z")],
      selectedThreadUiStatus: "idle",
      timelineItems: [
        makeMessageTimelineItem("user", "user-1"),
        makeMessageTimelineItem("assistant", "assistant-1"),
      ],
    })).toEqual({
      label: "Worked",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:08Z",
      state: "completed",
    });
  });
});
