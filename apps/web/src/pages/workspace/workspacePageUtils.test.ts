import { describe, expect, it } from "vitest";
import type { ChatTimelineItem } from "@codesymphony/shared-types";
import { shouldShowThinkingPlaceholder } from "./workspacePageUtils";

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

describe("shouldShowThinkingPlaceholder", () => {
  it("shows placeholder while running before an assistant timeline item exists", () => {
    expect(shouldShowThinkingPlaceholder({
      selectedThreadUiStatus: "running",
      isWaitingForUserGate: false,
      timelineItems: [makeMessageTimelineItem("user", "user-1")],
    })).toBe(true);
  });

  it("hides placeholder once the latest timeline item is an assistant message", () => {
    expect(shouldShowThinkingPlaceholder({
      selectedThreadUiStatus: "running",
      isWaitingForUserGate: false,
      timelineItems: [
        makeMessageTimelineItem("user", "user-1"),
        makeMessageTimelineItem("assistant", "assistant-1"),
      ],
    })).toBe(false);
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
});
