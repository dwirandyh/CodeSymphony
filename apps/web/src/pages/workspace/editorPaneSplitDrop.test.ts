import { describe, expect, it } from "vitest";
import {
  applyEditorTabPaneDrop,
  resolvePaneSplitDropTarget,
  resolvePaneEdgeFromPointer,
} from "./editorPaneSplitDrop";
import { createEmptyEditorGroupsState } from "./editorGroups";
import { PANE_EDGE_BAND_RATIO } from "./editorPaneSplitDropConstants";

function rect(width: number, height = 400): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

describe("resolvePaneEdgeFromPointer", () => {
  it("detects right edge band only (no vertical edges)", () => {
    const r = rect(400, 400);
    const rightEdge = r.width * (1 - PANE_EDGE_BAND_RATIO) + 1;
    expect(
      resolvePaneEdgeFromPointer({
        rect: r,
        clientX: rightEdge,
        clientY: 200,
      }),
    ).toBe("right");
    expect(
      resolvePaneEdgeFromPointer({
        rect: r,
        clientX: 200,
        clientY: r.height - 1,
      }),
    ).toBeNull();
  });
});

describe("resolvePaneSplitDropTarget", () => {
  it("single pane: right edge → split-right; bottom band → null", () => {
    const r = rect(400, 400);
    const rightEdge = r.width * (1 - PANE_EDGE_BAND_RATIO) + 1;
    const bottomEdge = r.height * (1 - PANE_EDGE_BAND_RATIO) + 1;
    expect(
      resolvePaneSplitDropTarget({
        layout: "single",
        paneGroupId: "topLeft",
        rect: r,
        clientX: rightEdge,
        clientY: 200,
      }),
    ).toBe("split-right");
    expect(
      resolvePaneSplitDropTarget({
        layout: "single",
        paneGroupId: "topLeft",
        rect: r,
        clientX: 200,
        clientY: bottomEdge,
      }),
    ).toBeNull();
  });

  it("horizontal: left pane right edge splits; right pane left edge moves", () => {
    const r = rect(400, 400);
    const rightEdge = r.width * (1 - PANE_EDGE_BAND_RATIO) + 1;
    expect(
      resolvePaneSplitDropTarget({
        layout: "horizontal",
        paneGroupId: "topLeft",
        rect: r,
        clientX: rightEdge,
        clientY: 200,
      }),
    ).toBe("split-right");
    expect(
      resolvePaneSplitDropTarget({
        layout: "horizontal",
        paneGroupId: "topRight",
        rect: r,
        clientX: 5,
        clientY: 200,
      }),
    ).toBe("move-to-left");
  });
});

describe("applyEditorTabPaneDrop", () => {
  it("split-right moves tab to topRight and enables horizontal layout", () => {
    const state = {
      ...createEmptyEditorGroupsState(),
      groups: {
        ...createEmptyEditorGroupsState().groups,
        topLeft: {
          tabs: [
            { type: "chat" as const, id: "thread-1" },
            { type: "file" as const, id: "a.ts" },
          ],
          activeTabId: "thread-1",
        },
      },
    };
    const next = applyEditorTabPaneDrop(state, "a.ts", "split-right", "topLeft");
    expect(next.layout).toBe("horizontal");
    expect(next.groups.topRight.tabs.map((t) => t.id)).toEqual(["a.ts"]);
  });
});