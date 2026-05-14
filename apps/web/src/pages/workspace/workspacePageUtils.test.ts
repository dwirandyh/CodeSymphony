import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatTimelineItem } from "@codesymphony/shared-types";
import {
  deriveWorkingStatus,
  shouldReturnToWorkspaceLandingAfterClosingContent,
  shouldShowThinkingPlaceholder,
  shouldShowWorkspaceEmptyState,
} from "./workspacePageUtils";

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

describe("shouldShowWorkspaceEmptyState", () => {
  it("shows the workspace landing when chat has no selected thread", () => {
    expect(shouldShowWorkspaceEmptyState({
      activeView: "chat",
      terminalViewActive: false,
      messageListEmptyState: "no-thread-selected",
    })).toBe(true);
  });

  it("shows the workspace landing while the first thread is still being prepared", () => {
    expect(shouldShowWorkspaceEmptyState({
      activeView: "chat",
      terminalViewActive: false,
      messageListEmptyState: "creating-thread",
    })).toBe(true);
  });

  it("keeps thread-specific empty states in the regular chat surface", () => {
    expect(shouldShowWorkspaceEmptyState({
      activeView: "chat",
      terminalViewActive: false,
      messageListEmptyState: "new-thread-empty",
    })).toBe(false);

    expect(shouldShowWorkspaceEmptyState({
      activeView: "chat",
      terminalViewActive: false,
      messageListEmptyState: "existing-thread-empty",
    })).toBe(false);
  });

  it("never shows the workspace landing over file, review, or terminal views", () => {
    expect(shouldShowWorkspaceEmptyState({
      activeView: "file",
      terminalViewActive: false,
      messageListEmptyState: "no-thread-selected",
    })).toBe(false);

    expect(shouldShowWorkspaceEmptyState({
      activeView: "review",
      terminalViewActive: false,
      messageListEmptyState: "no-thread-selected",
    })).toBe(false);

    expect(shouldShowWorkspaceEmptyState({
      activeView: "chat",
      terminalViewActive: true,
      messageListEmptyState: "no-thread-selected",
    })).toBe(false);
  });
});

describe("shouldReturnToWorkspaceLandingAfterClosingContent", () => {
  it("returns to the landing for threadless and empty-thread chat states", () => {
    expect(shouldReturnToWorkspaceLandingAfterClosingContent("no-thread-selected")).toBe(true);
    expect(shouldReturnToWorkspaceLandingAfterClosingContent("creating-thread")).toBe(true);
    expect(shouldReturnToWorkspaceLandingAfterClosingContent("new-thread-empty")).toBe(true);
    expect(shouldReturnToWorkspaceLandingAfterClosingContent("existing-thread-empty")).toBe(true);
  });

  it("keeps populated or loading threads on the chat surface", () => {
    expect(shouldReturnToWorkspaceLandingAfterClosingContent("loading-thread")).toBe(false);
    expect(shouldReturnToWorkspaceLandingAfterClosingContent(null)).toBe(false);
  });
});
