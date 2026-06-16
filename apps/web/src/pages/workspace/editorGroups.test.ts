import { describe, expect, it } from "vitest";
import {
  type TabItem,
  type EditorGroupsState,
  reconcileEditorGroups,
  moveTab,
  splitActiveTab,
  closeTabInGroup
} from "./editorGroups";

describe("editorGroups state management", () => {
  const emptyState = (): EditorGroupsState => ({
    splitMode: false,
    activeGroupId: "left",
    left: { tabs: [], activeTabId: null },
    right: { tabs: [], activeTabId: null },
  });

  describe("reconcileEditorGroups", () => {
    it("adds new source tabs to the active group", () => {
      const state = emptyState();
      const sourceTabs: TabItem[] = [
        { type: "file", id: "file1.ts" },
        { type: "chat", id: "thread1" },
      ];

      const reconciled = reconcileEditorGroups(state, sourceTabs);

      expect(reconciled.left.tabs).toHaveLength(2);
      expect(reconciled.left.tabs[0]).toEqual({ type: "file", id: "file1.ts" });
      expect(reconciled.left.tabs[1]).toEqual({ type: "chat", id: "thread1" });
      expect(reconciled.left.activeTabId).toBe("file1.ts");
    });

    it("removes tabs that are no longer in sourceTabs", () => {
      const state: EditorGroupsState = {
        splitMode: true,
        activeGroupId: "left",
        left: {
          tabs: [
            { type: "file", id: "file1.ts" },
            { type: "chat", id: "thread1" },
          ],
          activeTabId: "file1.ts",
        },
        right: {
          tabs: [{ type: "terminal", id: "term1" }],
          activeTabId: "term1",
        },
      };

      // file1.ts is closed
      const sourceTabs: TabItem[] = [
        { type: "chat", id: "thread1" },
        { type: "terminal", id: "term1" },
      ];

      const reconciled = reconcileEditorGroups(state, sourceTabs);

      expect(reconciled.left.tabs).toHaveLength(1);
      expect(reconciled.left.tabs[0].id).toBe("thread1");
      expect(reconciled.left.activeTabId).toBe("thread1"); // fell back to thread1
      expect(reconciled.right.tabs).toHaveLength(1);
      expect(reconciled.right.activeTabId).toBe("term1");
    });

    it("automatically turns off splitMode if a group becomes empty", () => {
      const state: EditorGroupsState = {
        splitMode: true,
        activeGroupId: "right",
        left: {
          tabs: [{ type: "file", id: "file1.ts" }],
          activeTabId: "file1.ts",
        },
        right: {
          tabs: [{ type: "terminal", id: "term1" }],
          activeTabId: "term1",
        },
      };

      // term1 is closed
      const sourceTabs: TabItem[] = [{ type: "file", id: "file1.ts" }];

      const reconciled = reconcileEditorGroups(state, sourceTabs);

      expect(reconciled.splitMode).toBe(false);
      expect(reconciled.activeGroupId).toBe("left");
      expect(reconciled.right.tabs).toHaveLength(0);
      expect(reconciled.right.activeTabId).toBeNull();
    });
  });

  describe("moveTab", () => {
    it("moves tab from left to right and enables splitMode", () => {
      const state: EditorGroupsState = {
        splitMode: false,
        activeGroupId: "left",
        left: {
          tabs: [
            { type: "file", id: "file1.ts" },
            { type: "chat", id: "thread1" },
          ],
          activeTabId: "file1.ts",
        },
        right: { tabs: [], activeTabId: null },
      };

      const result = moveTab(state, "file1.ts", "right");

      expect(result.splitMode).toBe(true);
      expect(result.activeGroupId).toBe("right");
      expect(result.left.tabs).toHaveLength(1);
      expect(result.left.tabs[0].id).toBe("thread1");
      expect(result.left.activeTabId).toBe("thread1");
      expect(result.right.tabs).toHaveLength(1);
      expect(result.right.tabs[0].id).toBe("file1.ts");
      expect(result.right.activeTabId).toBe("file1.ts");
    });
  });

  describe("splitActiveTab", () => {
    it("splits the active tab of the current group to the other group", () => {
      const state: EditorGroupsState = {
        splitMode: false,
        activeGroupId: "left",
        left: {
          tabs: [
            { type: "file", id: "file1.ts" },
            { type: "chat", id: "thread1" },
          ],
          activeTabId: "file1.ts",
        },
        right: { tabs: [], activeTabId: null },
      };

      const result = splitActiveTab(state);

      expect(result.splitMode).toBe(true);
      expect(result.activeGroupId).toBe("right");
      expect(result.left.tabs).toHaveLength(1);
      expect(result.right.tabs).toHaveLength(1);
      expect(result.right.tabs[0].id).toBe("file1.ts");
    });

    it("returns state unchanged when no active tab to split", () => {
      const state = emptyState();

      const result = splitActiveTab(state);

      expect(result).toBe(state);
      expect(result.splitMode).toBe(false);
    });
  });
});

describe("moveTabToGroup", () => {
  it("moves a tab from left to right when target differs from current group", async () => {
    const { moveTabToGroup } = await import("./editorGroups");
    const state = {
      splitMode: true,
      activeGroupId: "left" as const,
      left: {
        tabs: [
          { type: "file" as const, id: "a.ts" },
          { type: "chat" as const, id: "thread-1" },
        ],
        activeTabId: "a.ts" as string | null,
      },
      right: {
        tabs: [{ type: "terminal" as const, id: "term-1" }],
        activeTabId: "term-1" as string | null,
      },
    };

    const next = moveTabToGroup(state, "a.ts", "right");

    expect(next.left.tabs.map((t) => t.id)).toEqual(["thread-1"]);
    expect(next.right.tabs.map((t) => t.id)).toEqual(["term-1", "a.ts"]);
    expect(next.right.activeTabId).toBe("a.ts");
    expect(next.activeGroupId).toBe("right");
    expect(next.splitMode).toBe(true);
  });

  it("returns the same state when dragging a tab onto its own group", async () => {
    const { moveTabToGroup } = await import("./editorGroups");
    const state = {
      splitMode: true,
      activeGroupId: "left" as const,
      left: {
        tabs: [{ type: "file" as const, id: "a.ts" }],
        activeTabId: "a.ts" as string | null,
      },
      right: {
        tabs: [{ type: "chat" as const, id: "thread-1" }],
        activeTabId: "thread-1" as string | null,
      },
    };

    const next = moveTabToGroup(state, "a.ts", "left");
    expect(next).toBe(state);
  });

  it("does nothing when the tab id is unknown", async () => {
    const { moveTabToGroup } = await import("./editorGroups");
    const state = {
      splitMode: false,
      activeGroupId: "left" as const,
      left: {
        tabs: [{ type: "file" as const, id: "a.ts" }],
        activeTabId: "a.ts" as string | null,
      },
      right: { tabs: [], activeTabId: null as string | null },
    };

    const next = moveTabToGroup(state, "missing", "right");
    expect(next).toBe(state);
  });

  it("collapses split mode when source group becomes empty after move", async () => {
    const { moveTabToGroup } = await import("./editorGroups");
    const state = {
      splitMode: true,
      activeGroupId: "right" as const,
      left: {
        tabs: [
          { type: "file" as const, id: "a.ts" },
          { type: "chat" as const, id: "thread-1" },
        ],
        activeTabId: "a.ts" as string | null,
      },
      right: {
        tabs: [{ type: "terminal" as const, id: "term-1" }],
        activeTabId: "term-1" as string | null,
      },
    };

    const next = moveTabToGroup(state, "term-1", "left");
    expect(next.splitMode).toBe(false);
    expect(next.right.tabs).toEqual([]);
    expect(next.left.tabs.map((t) => t.id)).toEqual(["a.ts", "thread-1", "term-1"]);
    expect(next.activeGroupId).toBe("left");
  });
});

describe("reorderTabInGroup", () => {
  const baseState = (): EditorGroupsState => ({
    splitMode: false,
    activeGroupId: "left",
    left: {
      tabs: [
        { type: "file", id: "a.ts" },
        { type: "chat", id: "thread-1" },
        { type: "terminal", id: "term-1" },
      ],
      activeTabId: "a.ts",
    },
    right: { tabs: [], activeTabId: null },
  });

  it("moves a tab forward to the target index", async () => {
    const { reorderTabInGroup } = await import("./editorGroups");
    const next = reorderTabInGroup(baseState(), "left", "a.ts", 2);
    expect(next.left.tabs.map((t) => t.id)).toEqual(["thread-1", "term-1", "a.ts"]);
    // active tab identity preserved
    expect(next.left.activeTabId).toBe("a.ts");
  });

  it("moves a tab backward to the target index", async () => {
    const { reorderTabInGroup } = await import("./editorGroups");
    const next = reorderTabInGroup(baseState(), "left", "term-1", 0);
    expect(next.left.tabs.map((t) => t.id)).toEqual(["term-1", "a.ts", "thread-1"]);
  });

  it("clamps target index to bounds", async () => {
    const { reorderTabInGroup } = await import("./editorGroups");
    const next = reorderTabInGroup(baseState(), "left", "a.ts", 99);
    expect(next.left.tabs.map((t) => t.id)).toEqual(["thread-1", "term-1", "a.ts"]);
  });

  it("returns the same state when tab id is unknown", async () => {
    const { reorderTabInGroup } = await import("./editorGroups");
    const state = baseState();
    const next = reorderTabInGroup(state, "left", "missing", 0);
    expect(next).toBe(state);
  });

  it("returns the same state when position is unchanged", async () => {
    const { reorderTabInGroup } = await import("./editorGroups");
    const state = baseState();
    const next = reorderTabInGroup(state, "left", "a.ts", 0);
    expect(next).toBe(state);
  });

  it("reorders within the right group independently", async () => {
    const { reorderTabInGroup } = await import("./editorGroups");
    const state: EditorGroupsState = {
      splitMode: true,
      activeGroupId: "right",
      left: { tabs: [{ type: "file", id: "a.ts" }], activeTabId: "a.ts" },
      right: {
        tabs: [
          { type: "chat", id: "thread-1" },
          { type: "terminal", id: "term-1" },
        ],
        activeTabId: "thread-1",
      },
    };
    const next = reorderTabInGroup(state, "right", "term-1", 0);
    expect(next.right.tabs.map((t) => t.id)).toEqual(["term-1", "thread-1"]);
    expect(next.left.tabs.map((t) => t.id)).toEqual(["a.ts"]);
  });
});
