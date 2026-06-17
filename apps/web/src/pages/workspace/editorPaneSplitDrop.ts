import {
  type EditorGroupsState,
  destinationForPaneSplit,
  layoutAfterPaneSplitEdge,
  moveTabToQuadrant,
} from "./editorGroups";
import type { EditorQuadrantId } from "./editorGroupTypes";
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

  const { layout, paneGroupId } = args;

  if (layout === "single" && paneGroupId === "topLeft") {
    if (edge === "right") return "split-right";
    return null;
  }

  if (layout === "horizontal") {
    if (paneGroupId === "topLeft" && edge === "right") return "split-right";
    if (paneGroupId === "topRight" && edge === "left") return "move-to-left";
    if (paneGroupId === "topRight" && edge === "right") return "move-to-right";
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
  const dest = destinationForPaneSplit(sourcePane, edge);
  const layout = layoutAfterPaneSplitEdge(state.layout, edge);
  return moveTabToQuadrant(state, tabId, dest, layout);
}