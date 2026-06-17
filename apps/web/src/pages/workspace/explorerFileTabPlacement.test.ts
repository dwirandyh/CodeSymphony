import { describe, expect, it } from "vitest";
import { createEmptyEditorGroupsState, reconcileEditorGroups } from "./editorGroups";
import {
  layoutAfterPlacingNewFileTab,
  targetGroupForNewExplorerFileTab,
} from "./explorerFileTabPlacement";

describe("targetGroupForNewExplorerFileTab", () => {
  it("targets topRight when layout is single", () => {
    const state = createEmptyEditorGroupsState();
    expect(targetGroupForNewExplorerFileTab(state)).toBe("topRight");
  });

  it("always targets topRight when already split", () => {
    const state = {
      ...createEmptyEditorGroupsState(),
      layout: "horizontal" as const,
      activeGroupId: "topLeft" as const,
      groups: {
        ...createEmptyEditorGroupsState().groups,
        topLeft: { tabs: [{ type: "chat" as const, id: "t1" }], activeTabId: "t1" },
        topRight: { tabs: [{ type: "terminal" as const, id: "term1" }], activeTabId: "term1" },
      },
    };
    expect(targetGroupForNewExplorerFileTab(state)).toBe("topRight");
    expect(targetGroupForNewExplorerFileTab({ ...state, activeGroupId: "topRight" })).toBe("topRight");
  });
});

describe("reconcileEditorGroups with explorer file placement", () => {
  it("places new file tabs on topRight and enables horizontal split from single", () => {
    const state = {
      ...createEmptyEditorGroupsState(),
      groups: {
        ...createEmptyEditorGroupsState().groups,
        topLeft: {
          tabs: [{ type: "chat" as const, id: "thread1" }],
          activeTabId: "thread1",
        },
      },
    };

    const reconciled = reconcileEditorGroups(state, [
      { type: "chat", id: "thread1" },
      { type: "file", id: "new.ts" },
    ], { newFileTabIds: ["new.ts"] });

    expect(reconciled.layout).toBe("horizontal");
    expect(reconciled.activeGroupId).toBe("topRight");
    expect(reconciled.groups.topLeft.tabs.map((t) => t.id)).toEqual(["thread1"]);
    expect(reconciled.groups.topRight.tabs.map((t) => t.id)).toEqual(["new.ts"]);
    expect(reconciled.groups.topRight.activeTabId).toBe("new.ts");
  });

  it("appends new explorer file tab on topRight when right column already has tabs", () => {
    const state = {
      ...createEmptyEditorGroupsState(),
      layout: "horizontal" as const,
      activeGroupId: "topLeft" as const,
      groups: {
        ...createEmptyEditorGroupsState().groups,
        topLeft: {
          tabs: [{ type: "chat" as const, id: "thread1" }],
          activeTabId: "thread1",
        },
        topRight: {
          tabs: [{ type: "terminal" as const, id: "term1" }],
          activeTabId: "term1",
        },
      },
    };

    const reconciled = reconcileEditorGroups(
      state,
      [
        { type: "chat", id: "thread1" },
        { type: "terminal", id: "term1" },
        { type: "file", id: "utils.ts" },
      ],
      { newFileTabIds: ["utils.ts"] },
    );

    expect(reconciled.activeGroupId).toBe("topRight");
    expect(reconciled.groups.topRight.tabs.map((t) => t.id)).toEqual(["term1", "utils.ts"]);
    expect(reconciled.groups.topRight.activeTabId).toBe("utils.ts");
  });

  it("still appends on topRight when focus is on the left column", () => {
    const state = {
      ...createEmptyEditorGroupsState(),
      layout: "horizontal" as const,
      activeGroupId: "topRight" as const,
      groups: {
        ...createEmptyEditorGroupsState().groups,
        topLeft: {
          tabs: [{ type: "chat" as const, id: "thread1" }],
          activeTabId: "thread1",
        },
        topRight: {
          tabs: [{ type: "file" as const, id: "old.ts" }],
          activeTabId: "old.ts",
        },
      },
    };

    const reconciled = reconcileEditorGroups(
      state,
      [
        { type: "chat", id: "thread1" },
        { type: "file", id: "old.ts" },
        { type: "file", id: "new.ts" },
      ],
      { newFileTabIds: ["new.ts"] },
    );

    expect(reconciled.activeGroupId).toBe("topRight");
    expect(reconciled.groups.topRight.tabs.map((t) => t.id)).toEqual(["old.ts", "new.ts"]);
  });
});

describe("layoutAfterPlacingNewFileTab", () => {
  it("enables horizontal split when placing on topRight from single", () => {
    const state = createEmptyEditorGroupsState();
    expect(layoutAfterPlacingNewFileTab(state, "topRight")).toBe("horizontal");
  });
});