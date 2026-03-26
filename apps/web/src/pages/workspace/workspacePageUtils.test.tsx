import { describe, expect, it } from "vitest";
import type { ChatTimelineItem } from "../../components/workspace/chat-message-list";
import { resolveChatMessageListKey, resolveVisibleTimelineItems } from "./workspacePageUtils";

function makeMessageItem(id: string, content = id): ChatTimelineItem {
  return {
    kind: "message",
    message: {
      id,
      threadId: "t1",
      seq: 1,
      role: "assistant",
      content,
      attachments: [],
      createdAt: "2026-01-01T00:00:00Z",
    },
    isCompleted: true,
  };
}

describe("workspacePageUtils", () => {
  it("keeps the existing chat list key when thread stays the same", () => {
    expect(resolveChatMessageListKey({
      previousKey: "thread-1",
      previousThreadId: "thread-1",
      nextThreadId: "thread-1",
    })).toBe("thread-1");
  });

  it("switches the chat list key when thread changes", () => {
    expect(resolveChatMessageListKey({
      previousKey: "thread-1",
      previousThreadId: "thread-1",
      nextThreadId: "thread-2",
    })).toBe("thread-2");
  });

  it("returns all items when no plan decision is shown", () => {
    const items: ChatTimelineItem[] = [
      makeMessageItem("m1"),
      {
        kind: "explore-activity",
        id: "explore-1",
        status: "success",
        fileCount: 1,
        searchCount: 1,
        entries: [],
      },
    ];

    expect(resolveVisibleTimelineItems({ items, showPlanDecisionComposer: false })).toEqual(items);
  });

  it("truncates items after the final plan card when plan decision is shown", () => {
    const items: ChatTimelineItem[] = [
      makeMessageItem("m1", "Before"),
      {
        kind: "plan-file-output",
        id: "plan-1",
        messageId: "m1",
        content: "# Plan",
        filePath: ".claude/plan.md",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        kind: "explore-activity",
        id: "explore-after",
        status: "success",
        fileCount: 2,
        searchCount: 0,
        entries: [],
      },
    ];

    expect(resolveVisibleTimelineItems({ items, showPlanDecisionComposer: true })).toEqual(items.slice(0, 2));
  });

  it("returns original items when no plan card exists", () => {
    const items: ChatTimelineItem[] = [
      makeMessageItem("m1"),
      {
        kind: "explore-activity",
        id: "explore-1",
        status: "success",
        fileCount: 1,
        searchCount: 0,
        entries: [],
      },
    ];

    expect(resolveVisibleTimelineItems({ items, showPlanDecisionComposer: true })).toEqual(items);
  });
});
