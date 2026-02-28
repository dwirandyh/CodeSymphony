import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatThread } from "@codesymphony/shared-types";
import { applyThreadTitleUpdate, extractLatestThreadMetadata } from "./useChatSession";

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
