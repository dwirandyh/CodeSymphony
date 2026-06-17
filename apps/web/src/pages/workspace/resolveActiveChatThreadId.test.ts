import { describe, expect, it } from "vitest";
import { createEmptyEditorGroupsState } from "./editorGroups";
import {
  resolveActiveChatThreadIdForUnsplitPane,
  resolveRequestedThreadIdForChatSession,
} from "./resolveActiveChatThreadId";
import { resolveUnsplitChatPaneThreadId } from "./unsplitChatSurface";

describe("resolveRequestedThreadIdForChatSession", () => {
  it("prefers explicit user intent over URL desired thread", () => {
    expect(
      resolveRequestedThreadIdForChatSession({
        desiredThreadId: "url-thread",
        userIntentThreadId: "clicked-thread",
        selectionDeferred: false,
      }),
    ).toBe("clicked-thread");
  });

  it("uses URL when user intent is undefined", () => {
    expect(
      resolveRequestedThreadIdForChatSession({
        desiredThreadId: "url-thread",
        userIntentThreadId: undefined,
        selectionDeferred: false,
      }),
    ).toBe("url-thread");
  });

  it("honors explicit null user intent (no thread)", () => {
    expect(
      resolveRequestedThreadIdForChatSession({
        desiredThreadId: "url-thread",
        userIntentThreadId: null,
        selectionDeferred: false,
      }),
    ).toBe(null);
  });
});

describe("resolveActiveChatThreadIdForUnsplitPane", () => {
  it("prefers selectedThreadId when it is an open chat tab (post-split tab strip desync)", () => {
    const editorGroups = createEmptyEditorGroupsState();
    editorGroups.groups.topLeft = {
      tabs: [
        { type: "chat", id: "thread-a" },
        { type: "chat", id: "thread-b" },
      ],
      activeTabId: "thread-b",
    };

    expect(
      resolveActiveChatThreadIdForUnsplitPane({
        splitMode: false,
        editorGroups,
        selectedThreadId: "thread-a",
      }),
    ).toBe("thread-a");
  });

  it("resolveUnsplitChatPaneThreadId matches unsplit pane helper", () => {
    const editorGroups = createEmptyEditorGroupsState();
    editorGroups.groups.topLeft = {
      tabs: [
        { type: "chat", id: "thread-a" },
        { type: "chat", id: "thread-b" },
      ],
      activeTabId: "thread-b",
    };

    expect(
      resolveUnsplitChatPaneThreadId({
        splitMode: false,
        editorGroups,
        selectedThreadId: "thread-a",
      }),
    ).toBe("thread-a");
  });

  it("falls back to active chat tab when selected is not in the strip", () => {
    const editorGroups = createEmptyEditorGroupsState();
    editorGroups.groups.topLeft = {
      tabs: [{ type: "chat", id: "thread-b" }],
      activeTabId: "thread-b",
    };

    expect(
      resolveActiveChatThreadIdForUnsplitPane({
        splitMode: false,
        editorGroups,
        selectedThreadId: "thread-a",
      }),
    ).toBe("thread-b");
  });

  it("falls back to selectedThreadId when active tab is not chat", () => {
    const editorGroups = createEmptyEditorGroupsState();
    editorGroups.groups.topLeft = {
      tabs: [{ type: "file", id: "src/a.ts" }],
      activeTabId: "src/a.ts",
    };

    expect(
      resolveActiveChatThreadIdForUnsplitPane({
        splitMode: false,
        editorGroups,
        selectedThreadId: "thread-a",
      }),
    ).toBe("thread-a");
  });
});