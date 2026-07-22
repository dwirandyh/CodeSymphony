import { describe, expect, it } from "vitest";
import {
  type TabItem,
  type EditorGroupsState,
  alignEditorActiveTabWithSelection,
  createEmptyEditorGroupsState,
  reconcileEditorGroups,
  moveTabToQuadrant,
  moveTabToGroup,
  splitActiveTab,
  closeTabInGroup,
  reorderTabInGroup,
  destinationForPaneSplit,
  layoutAfterPaneSplitEdge,
} from "./editorGroups";

describe("editorGroups state management", () => {
  const emptyState = (): EditorGroupsState => createEmptyEditorGroupsState();

  describe("reconcileEditorGroups", () => {
    it("adds new source tabs to the active group", () => {
      const state = emptyState();
      const sourceTabs: TabItem[] = [
        { type: "file", id: "file1.ts" },
        { type: "chat", id: "thread1" },
      ];

      const reconciled = reconcileEditorGroups(state, sourceTabs);

      expect(reconciled.groups.topLeft.tabs).toHaveLength(2);
      expect(reconciled.groups.topLeft.activeTabId).toBe("file1.ts");
    });

    it("activates a newly added chat tab when requested so the unsplit pane follows it", () => {
      const state: EditorGroupsState = {
        ...emptyState(),
        groups: {
          ...emptyState().groups,
          topLeft: {
            tabs: [{ type: "chat", id: "thread-old" }],
            activeTabId: "thread-old",
          },
        },
      };
      const sourceTabs: TabItem[] = [
        { type: "chat", id: "thread-old" },
        { type: "chat", id: "thread-new" },
      ];

      const reconciled = reconcileEditorGroups(state, sourceTabs, {
        activateTabId: "thread-new",
      });

      expect(reconciled.groups.topLeft.activeTabId).toBe("thread-new");
    });

    it("activates a newly added terminal tab in the focused split pane", () => {
      const state: EditorGroupsState = {
        ...emptyState(),
        layout: "horizontal",
        splitMode: true,
        activeGroupId: "topRight",
        groups: {
          ...emptyState().groups,
          topLeft: {
            tabs: [{ type: "chat", id: "thread-1" }],
            activeTabId: "thread-1",
          },
          topRight: {
            tabs: [{ type: "terminal", id: "term-old" }],
            activeTabId: "term-old",
          },
        },
      };
      const sourceTabs: TabItem[] = [
        { type: "chat", id: "thread-1" },
        { type: "terminal", id: "term-old" },
        { type: "terminal", id: "term-new" },
      ];

      const reconciled = reconcileEditorGroups(state, sourceTabs, {
        activateTabId: "term-new",
      });

      expect(reconciled.groups.topRight.activeTabId).toBe("term-new");
      expect(reconciled.groups.topLeft.activeTabId).toBe("thread-1");
      expect(reconciled.groups.topRight.tabs.map((t) => t.id)).toEqual(["term-old", "term-new"]);
    });

    it("activates a newly added chat tab in the focused split pane", () => {
      const state: EditorGroupsState = {
        ...emptyState(),
        layout: "horizontal",
        splitMode: true,
        activeGroupId: "topRight",
        groups: {
          ...emptyState().groups,
          topLeft: {
            tabs: [{ type: "chat", id: "thread-1" }],
            activeTabId: "thread-1",
          },
          topRight: {
            tabs: [{ type: "chat", id: "thread-2" }],
            activeTabId: "thread-2",
          },
        },
      };
      const sourceTabs: TabItem[] = [
        { type: "chat", id: "thread-1" },
        { type: "chat", id: "thread-2" },
        { type: "chat", id: "thread-new" },
      ];

      const reconciled = reconcileEditorGroups(state, sourceTabs, {
        activateTabId: "thread-new",
      });

      expect(reconciled.groups.topRight.activeTabId).toBe("thread-new");
      expect(reconciled.groups.topLeft.activeTabId).toBe("thread-1");
    });

    it("does not move the active tab when the requested chat tab is not newly added", () => {
      const state: EditorGroupsState = {
        ...emptyState(),
        groups: {
          ...emptyState().groups,
          topLeft: {
            tabs: [
              { type: "chat", id: "thread-old" },
              { type: "chat", id: "thread-new" },
            ],
            activeTabId: "thread-old",
          },
        },
      };
      const sourceTabs: TabItem[] = [
        { type: "chat", id: "thread-old" },
        { type: "chat", id: "thread-new" },
      ];

      const reconciled = reconcileEditorGroups(state, sourceTabs, {
        activateTabId: "thread-new",
      });

      expect(reconciled.groups.topLeft.activeTabId).toBe("thread-old");
    });

    it("still honors deprecated activateChatTabId", () => {
      const state: EditorGroupsState = {
        ...emptyState(),
        groups: {
          ...emptyState().groups,
          topLeft: {
            tabs: [{ type: "chat", id: "thread-old" }],
            activeTabId: "thread-old",
          },
        },
      };
      const reconciled = reconcileEditorGroups(
        state,
        [
          { type: "chat", id: "thread-old" },
          { type: "chat", id: "thread-new" },
        ],
        { activateChatTabId: "thread-new" },
      );
      expect(reconciled.groups.topLeft.activeTabId).toBe("thread-new");
    });

    it("places explorer file tabs on topRight and enables horizontal split on first open", () => {
      const state: EditorGroupsState = {
        ...emptyState(),
        groups: {
          ...emptyState().groups,
          topLeft: {
            tabs: [{ type: "chat", id: "thread-1" }],
            activeTabId: "thread-1",
          },
        },
      };
      const sourceTabs: TabItem[] = [
        { type: "chat", id: "thread-1" },
        { type: "file", id: "src/a.ts" },
      ];

      const reconciled = reconcileEditorGroups(state, sourceTabs, {
        newFileTabIds: ["src/a.ts"],
      });

      expect(reconciled.layout).toBe("horizontal");
      expect(reconciled.activeGroupId).toBe("topRight");
      expect(reconciled.groups.topLeft.tabs.map((t) => t.id)).toEqual(["thread-1"]);
      expect(reconciled.groups.topRight.tabs.map((t) => t.id)).toEqual(["src/a.ts"]);
      expect(reconciled.groups.topRight.activeTabId).toBe("src/a.ts");
    });

    it("collapses horizontal split when right quadrant is empty", () => {
      const state: EditorGroupsState = {
        ...createEmptyEditorGroupsState(),
        layout: "horizontal",
        splitMode: true,
        groups: {
          topLeft: {
            tabs: [{ type: "file", id: "file1.ts" }],
            activeTabId: "file1.ts",
          },
          topRight: { tabs: [], activeTabId: null },
          bottomLeft: { tabs: [], activeTabId: null },
          bottomRight: { tabs: [], activeTabId: null },
        },
      };

      const reconciled = reconcileEditorGroups(state, [{ type: "file", id: "file1.ts" }]);
      expect(reconciled.layout).toBe("single");
      expect(reconciled.splitMode).toBe(false);
    });

    it("folds bottom-row tabs into topLeft on reconcile", () => {
      const state: EditorGroupsState = {
        ...createEmptyEditorGroupsState(),
        layout: "horizontal",
        groups: {
          ...createEmptyEditorGroupsState().groups,
          topLeft: { tabs: [{ type: "file", id: "a.ts" }], activeTabId: "a.ts" },
          bottomLeft: { tabs: [{ type: "chat", id: "t1" }], activeTabId: "t1" },
        },
      };
      const reconciled = reconcileEditorGroups(state, [
        { type: "file", id: "a.ts" },
        { type: "chat", id: "t1" },
      ]);
      expect(reconciled.layout).toBe("horizontal");
      expect(reconciled.groups.topLeft.tabs.map((t) => t.id)).toEqual(["a.ts"]);
      expect(reconciled.groups.topRight.tabs.map((t) => t.id)).toEqual(["t1"]);
      expect(reconciled.groups.bottomLeft.tabs).toHaveLength(0);
    });
  });

  describe("moveTabToQuadrant", () => {
    it("enables horizontal split when moving to topRight", () => {
      const state: EditorGroupsState = {
        ...createEmptyEditorGroupsState(),
        groups: {
          ...createEmptyEditorGroupsState().groups,
          topLeft: {
            tabs: [
              { type: "file", id: "file1.ts" },
              { type: "chat", id: "thread1" },
            ],
            activeTabId: "file1.ts",
          },
        },
      };

      const result = moveTabToQuadrant(state, "file1.ts", "topRight", "horizontal");

      expect(result.layout).toBe("horizontal");
      expect(result.groups.topRight.tabs.map((t) => t.id)).toEqual(["file1.ts"]);
      expect(result.groups.topLeft.tabs.map((t) => t.id)).toEqual(["thread1"]);
    });

    it("opens third column when moving to bottomLeft slot", () => {
      const state: EditorGroupsState = {
        ...createEmptyEditorGroupsState(),
        groups: {
          ...createEmptyEditorGroupsState().groups,
          topLeft: {
            tabs: [
              { type: "file", id: "a.ts" },
              { type: "chat", id: "thread-1" },
            ],
            activeTabId: "a.ts",
          },
        },
      };

      const withRight: EditorGroupsState = {
        ...state,
        layout: "horizontal",
        groups: {
          ...state.groups,
          topRight: { tabs: [{ type: "file", id: "b.ts" }], activeTabId: "b.ts" },
        },
      };
      const result = moveTabToQuadrant(withRight, "a.ts", "bottomLeft", "horizontal");
      expect(result.layout).toBe("horizontal");
      expect(result.groups.bottomLeft.tabs[0]?.id).toBe("a.ts");
    });
  });

  describe("splitActiveTab", () => {
    it("opens third column when two columns already filled", () => {
      const state: EditorGroupsState = {
        ...createEmptyEditorGroupsState(),
        layout: "horizontal",
        activeGroupId: "topLeft",
        groups: {
          ...createEmptyEditorGroupsState().groups,
          topLeft: {
            tabs: [
              { type: "file", id: "file1.ts" },
              { type: "chat", id: "thread1" },
            ],
            activeTabId: "file1.ts",
          },
          topRight: {
            tabs: [{ type: "chat", id: "thread2" }],
            activeTabId: "thread2",
          },
        },
      };
      const result = splitActiveTab(state);
      expect(result.groups.bottomLeft.tabs[0]?.id).toBe("file1.ts");
      expect(result.groups.topLeft.tabs.map((t) => t.id)).toEqual(["thread1"]);
    });

    it("splits active tab to topRight", () => {
      const state: EditorGroupsState = {
        ...createEmptyEditorGroupsState(),
        groups: {
          ...createEmptyEditorGroupsState().groups,
          topLeft: {
            tabs: [
              { type: "file", id: "file1.ts" },
              { type: "chat", id: "thread1" },
            ],
            activeTabId: "file1.ts",
          },
        },
      };

      const result = splitActiveTab(state);
      expect(result.layout).toBe("horizontal");
      expect(result.groups.topRight.tabs[0]?.id).toBe("file1.ts");
    });
  });

  describe("pane split helpers", () => {
    it("maps edges using column order up to four panes", () => {
      const groups = createEmptyEditorGroupsState().groups;
      expect(destinationForPaneSplit(groups, "topLeft", "right")).toBe("topRight");
      const twoCols: EditorGroupsState["groups"] = {
        ...groups,
        topLeft: { tabs: [{ type: "file" as const, id: "a" }], activeTabId: "a" },
        topRight: { tabs: [{ type: "file" as const, id: "b" }], activeTabId: "b" },
      };
      expect(destinationForPaneSplit(twoCols, "topRight", "right")).toBe("bottomLeft");
      expect(destinationForPaneSplit(twoCols, "topRight", "left")).toBe("topLeft");
    });

    it("always enables horizontal layout from pane split edge", () => {
      expect(layoutAfterPaneSplitEdge("single", "right")).toBe("horizontal");
      expect(layoutAfterPaneSplitEdge("horizontal", "left")).toBe("horizontal");
    });
  });

  describe("moveTabToGroup", () => {
    it("inserts moved tab at target index in another column", () => {
      const state: EditorGroupsState = {
        ...createEmptyEditorGroupsState(),
        layout: "horizontal",
        activeGroupId: "topLeft",
        groups: {
          ...createEmptyEditorGroupsState().groups,
          topLeft: {
            tabs: [
              { type: "chat", id: "thread-1" },
              { type: "file", id: "a.ts" },
            ],
            activeTabId: "thread-1",
          },
          topRight: {
            tabs: [{ type: "file", id: "b.ts" }],
            activeTabId: "b.ts",
          },
        },
      };

      const result = moveTabToGroup(state, "a.ts", "topRight", 0);

      expect(result.activeGroupId).toBe("topRight");
      expect(result.groups.topRight.tabs.map((t) => t.id)).toEqual(["a.ts", "b.ts"]);
      expect(result.groups.topLeft.tabs.map((t) => t.id)).toEqual(["thread-1"]);
    });
  });

  describe("reorderTabInGroup", () => {
    it("reorders within topLeft", () => {
      const state: EditorGroupsState = {
        ...createEmptyEditorGroupsState(),
        groups: {
          ...createEmptyEditorGroupsState().groups,
          topLeft: {
            tabs: [
              { type: "file", id: "a.ts" },
              { type: "chat", id: "thread-1" },
            ],
            activeTabId: "a.ts",
          },
        },
      };
      const next = reorderTabInGroup(state, "topLeft", "a.ts", 1);
      expect(next.groups.topLeft.tabs.map((t) => t.id)).toEqual(["thread-1", "a.ts"]);
    });
  });

  describe("closeTabInGroup", () => {
    it("closes tab and reconciles layout", () => {
      const state: EditorGroupsState = {
        ...createEmptyEditorGroupsState(),
        layout: "horizontal",
        splitMode: true,
        groups: {
          topLeft: { tabs: [{ type: "file", id: "a.ts" }], activeTabId: "a.ts" },
          topRight: { tabs: [{ type: "chat", id: "t1" }], activeTabId: "t1" },
          bottomLeft: { tabs: [], activeTabId: null },
          bottomRight: { tabs: [], activeTabId: null },
        },
      };
      const { nextState } = closeTabInGroup(state, "t1", "topRight");
      expect(nextState.layout).toBe("single");
    });
  });

  describe("alignEditorActiveTabWithSelection", () => {
    it("updates topLeft in single layout", () => {
      const state: EditorGroupsState = {
        ...emptyState(),
        groups: {
          ...emptyState().groups,
          topLeft: {
            tabs: [
              { type: "chat", id: "thread-a" },
              { type: "terminal", id: "term-1" },
            ],
            activeTabId: "thread-a",
          },
        },
      };

      const next = alignEditorActiveTabWithSelection(state, "term-1");
      expect(next.groups.topLeft.activeTabId).toBe("term-1");
    });

    it("updates only the focused pane in split layout", () => {
      const state: EditorGroupsState = {
        ...emptyState(),
        layout: "horizontal",
        splitMode: true,
        activeGroupId: "topRight",
        groups: {
          ...emptyState().groups,
          topLeft: {
            tabs: [{ type: "chat", id: "thread-a" }],
            activeTabId: "thread-a",
          },
          topRight: {
            tabs: [
              { type: "chat", id: "thread-b" },
              { type: "terminal", id: "term-new" },
            ],
            activeTabId: "thread-b",
          },
        },
      };

      const next = alignEditorActiveTabWithSelection(state, "term-new");
      expect(next.groups.topRight.activeTabId).toBe("term-new");
      expect(next.groups.topLeft.activeTabId).toBe("thread-a");
      expect(next.activeGroupId).toBe("topRight");
    });

    it("does not activate a tab that lives in another pane", () => {
      const state: EditorGroupsState = {
        ...emptyState(),
        layout: "horizontal",
        splitMode: true,
        activeGroupId: "topRight",
        groups: {
          ...emptyState().groups,
          topLeft: {
            tabs: [{ type: "chat", id: "thread-a" }],
            activeTabId: "thread-a",
          },
          topRight: {
            tabs: [{ type: "chat", id: "thread-b" }],
            activeTabId: "thread-b",
          },
        },
      };

      const next = alignEditorActiveTabWithSelection(state, "thread-a");
      expect(next).toBe(state);
    });
  });
});