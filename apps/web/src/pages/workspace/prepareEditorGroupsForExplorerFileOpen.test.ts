import { describe, expect, it } from "vitest";
import { createEmptyEditorGroupsState, type TabItem } from "./editorGroups";
import { prepareEditorGroupsForExplorerFileOpen } from "./prepareEditorGroupsForExplorerFileOpen";

describe("prepareEditorGroupsForExplorerFileOpen", () => {
  it("enables horizontal split with chat left and new file right (desktop)", () => {
    const state = {
      ...createEmptyEditorGroupsState(),
      groups: {
        ...createEmptyEditorGroupsState().groups,
        topLeft: {
          tabs: [{ type: "chat" as const, id: "thread-1" }],
          activeTabId: "thread-1",
        },
      },
    };
    const sourceTabs: TabItem[] = [
      { type: "chat", id: "thread-1" },
      { type: "file", id: "src/a.ts" },
    ];

    const next = prepareEditorGroupsForExplorerFileOpen({
      state,
      sourceTabs,
      filePath: "src/a.ts",
      allowExplorerFileSplit: true,
    });

    expect(next.layout).toBe("horizontal");
    expect(next.splitMode).toBe(true);
    expect(next.groups.topLeft.tabs.map((t) => t.id)).toEqual(["thread-1"]);
    expect(next.groups.topRight.tabs.map((t) => t.id)).toEqual(["src/a.ts"]);
  });

  it("appends the file tab when source tabs have not re-rendered yet", () => {
    const state = {
      ...createEmptyEditorGroupsState(),
      groups: {
        ...createEmptyEditorGroupsState().groups,
        topLeft: {
          tabs: [{ type: "chat" as const, id: "thread-1" }],
          activeTabId: "thread-1",
        },
      },
    };
    const sourceTabs: TabItem[] = [{ type: "chat", id: "thread-1" }];

    const next = prepareEditorGroupsForExplorerFileOpen({
      state,
      sourceTabs,
      filePath: "src/new.ts",
      allowExplorerFileSplit: true,
    });

    expect(next.layout).toBe("horizontal");
    expect(next.groups.topRight.tabs.map((t) => t.id)).toEqual(["src/new.ts"]);
  });

  it("keeps single layout on mobile (explorer split disabled)", () => {
    const state = {
      ...createEmptyEditorGroupsState(),
      groups: {
        ...createEmptyEditorGroupsState().groups,
        topLeft: {
          tabs: [{ type: "chat" as const, id: "thread-1" }],
          activeTabId: "thread-1",
        },
      },
    };
    const sourceTabs: TabItem[] = [
      { type: "chat", id: "thread-1" },
      { type: "file", id: "src/a.ts" },
    ];

    const next = prepareEditorGroupsForExplorerFileOpen({
      state,
      sourceTabs,
      filePath: "src/a.ts",
      allowExplorerFileSplit: false,
    });

    expect(next.layout).toBe("single");
    expect(next.splitMode).toBe(false);
    expect(next.groups.topLeft.tabs.map((t) => t.id)).toEqual(["thread-1", "src/a.ts"]);
  });
});