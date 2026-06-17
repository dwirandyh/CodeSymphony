import { describe, expect, it } from "vitest";
import {
  type TabItem,
  type EditorGroupsState,
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
});