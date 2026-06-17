import { describe, expect, it } from "vitest";
import {
  activeColumnIds,
  compactEditorColumns,
  defaultColumnWidthPercents,
  firstEmptyColumnToTheRight,
  normalizeColumnWidths,
  visibleEditorColumnIds,
} from "./editorColumns";
import { createEmptyEditorGroupsState, type EditorGroupsState } from "./editorGroups";

describe("editorColumns", () => {
  it("defaultColumnWidthPercents splits evenly", () => {
    expect(defaultColumnWidthPercents(2)).toEqual([50, 50]);
    expect(defaultColumnWidthPercents(3)[0]).toBeCloseTo(33.333, 2);
    expect(defaultColumnWidthPercents(3).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
  });

  it("activeColumnIds returns left-to-right occupied slots", () => {
    const base = createEmptyEditorGroupsState();
    const groups = {
      ...base.groups,
      topLeft: { tabs: [{ type: "file" as const, id: "a" }], activeTabId: "a" },
      topRight: { tabs: [], activeTabId: null },
      bottomLeft: { tabs: [{ type: "chat" as const, id: "t1" }], activeTabId: "t1" },
    };
    expect(activeColumnIds(groups)).toEqual(["topLeft", "bottomLeft"]);
  });

  it("compactEditorColumns packs columns and clears gaps", () => {
    const state: EditorGroupsState = {
      ...createEmptyEditorGroupsState(),
      layout: "horizontal",
      activeGroupId: "bottomLeft",
      groups: {
        ...createEmptyEditorGroupsState().groups,
        topLeft: { tabs: [{ type: "file", id: "a" }], activeTabId: "a" },
        topRight: { tabs: [], activeTabId: null },
        bottomLeft: { tabs: [{ type: "chat", id: "t1" }], activeTabId: "t1" },
        bottomRight: { tabs: [], activeTabId: null },
      },
    };
    const next = compactEditorColumns(state);
    expect(activeColumnIds(next.groups)).toEqual(["topLeft", "topRight"]);
    expect(next.groups.topRight.tabs[0]?.id).toBe("t1");
    expect(next.activeGroupId).toBe("topRight");
    expect(next.groups.bottomLeft.tabs).toHaveLength(0);
  });

  it("firstEmptyColumnToTheRight finds next slot up to 4", () => {
    const base = createEmptyEditorGroupsState().groups;
    const groups: EditorGroupsState["groups"] = {
      ...base,
      topLeft: { tabs: [{ type: "file" as const, id: "a" }], activeTabId: "a" },
      topRight: { tabs: [{ type: "file" as const, id: "b" }], activeTabId: "b" },
    };
    expect(firstEmptyColumnToTheRight(groups, "topLeft")).toBe("bottomLeft");
    expect(firstEmptyColumnToTheRight(groups, "bottomRight")).toBeNull();
  });

  it("visibleEditorColumnIds uses contiguous prefix", () => {
    const state: EditorGroupsState = {
      ...createEmptyEditorGroupsState(),
      layout: "horizontal",
      groups: {
        ...createEmptyEditorGroupsState().groups,
        topLeft: { tabs: [{ type: "file", id: "a" }], activeTabId: "a" },
        topRight: { tabs: [{ type: "chat", id: "t1" }], activeTabId: "t1" },
        bottomLeft: { tabs: [{ type: "file", id: "c" }], activeTabId: "c" },
      },
    };
    expect(visibleEditorColumnIds(state)).toEqual(["topLeft", "topRight", "bottomLeft"]);
  });

  it("normalizeColumnWidths pads to count", () => {
    expect(normalizeColumnWidths([60, 40], 2)).toEqual([60, 40]);
    expect(normalizeColumnWidths([50], 3).length).toBe(3);
  });
});