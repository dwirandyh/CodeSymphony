import {
  type EditorGroupsState,
  destinationForPaneSplit,
  layoutAfterPaneSplitEdge,
  moveTabToQuadrant,
} from "./editorGroups";
import type { EditorQuadrantId } from "./editorGroupTypes";
import { columnIndex, firstEmptyColumnToTheRight, HORIZONTAL_EDITOR_COLUMN_IDS } from "./editorColumns";
import { PANE_EDGE_BAND_RATIO } from "./editorPaneSplitDropConstants";

export { PANE_EDGE_BAND_RATIO } from "./editorPaneSplitDropConstants";

export type PaneEdgeDrop = "left" | "right";

export type PaneSplitDropTarget = "split-right" | "move-to-left" | "move-to-right";

export function resolvePaneEdgeFromPointer(args: {
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">;
  clientX: number;
  clientY: number;
}): PaneEdgeDrop | null {
  const { rect, clientX } = args;
  if (rect.width <= 0) {
    return null;
  }

  const relX = clientX - rect.left;
  const xBand = rect.width * PANE_EDGE_BAND_RATIO;

  const inLeft = relX <= xBand;
  const inRight = relX >= rect.width - xBand;

  if (inLeft && inRight) {
    return relX < rect.width / 2 ? "left" : "right";
  }
  if (inLeft) return "left";
  if (inRight) return "right";
  return null;
}

export function resolvePaneSplitDropTarget(args: {
  layout: import("./editorGroupTypes").EditorLayoutMode;
  paneGroupId: EditorQuadrantId;
  groups: EditorGroupsState["groups"];
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">;
  clientX: number;
  clientY: number;
}): PaneSplitDropTarget | null {
  const edge = resolvePaneEdgeFromPointer({
    rect: args.rect,
    clientX: args.clientX,
    clientY: args.clientY,
  });
  if (!edge) {
    return null;
  }

  const { layout, paneGroupId, groups } = args;

  if (layout === "single" && paneGroupId === "topLeft") {
    if (edge === "right") return "split-right";
    return null;
  }

  if (layout === "horizontal") {
    const idx = columnIndex(paneGroupId);
    if (edge === "left" && idx > 0) {
      return "move-to-left";
    }
    if (edge === "right") {
      const empty = firstEmptyColumnToTheRight(groups, paneGroupId);
      if (empty) {
        return "split-right";
      }
      if (idx < HORIZONTAL_EDITOR_COLUMN_IDS.length - 1) {
        return "move-to-right";
      }
    }
  }

  return null;
}

function paneEdgeFromLegacyTarget(target: PaneSplitDropTarget): PaneEdgeDrop {
  switch (target) {
    case "split-right":
    case "move-to-right":
      return "right";
    case "move-to-left":
      return "left";
  }
}

export function applyEditorTabPaneDrop(
  state: EditorGroupsState,
  tabId: string,
  target: PaneSplitDropTarget | null,
  sourcePane: EditorQuadrantId,
): EditorGroupsState {
  if (target === null) {
    return state;
  }

  const edge = paneEdgeFromLegacyTarget(target);
  const dest = destinationForPaneSplit(state.groups, sourcePane, edge);
  if (dest === sourcePane && (target === "split-right" || target === "move-to-right")) {
    return state;
  }
  const layout = layoutAfterPaneSplitEdge(state.layout, edge);
  return moveTabToQuadrant(state, tabId, dest, layout);
}