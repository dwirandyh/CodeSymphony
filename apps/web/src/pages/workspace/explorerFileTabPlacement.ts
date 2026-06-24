import type { EditorLayoutMode, EditorQuadrantId } from "./editorGroupTypes";
import { layoutAfterEnablingHorizontalSplit } from "./editorGroupTypes";

export type ExplorerFileTabPlacementState = {
  layout: EditorLayoutMode;
  activeGroupId: EditorQuadrantId;
  groups: Record<EditorQuadrantId, { tabs: Array<unknown> }>;
};

export type ExplorerFileTabPlacementOptions = {
  /** Desktop/web: open explorer files in the right column and enable split. Mobile: keep single pane. */
  allowExplorerFileSplit?: boolean;
};

/** Explorer files open in the right editor column on desktop; mobile keeps the active column. */
export function targetGroupForNewExplorerFileTab(
  _state: ExplorerFileTabPlacementState,
  options?: ExplorerFileTabPlacementOptions,
): EditorQuadrantId {
  if (options?.allowExplorerFileSplit === false) {
    return "topLeft";
  }
  return "topRight";
}

export function layoutAfterPlacingNewFileTab(
  state: ExplorerFileTabPlacementState,
  targetGroupId: EditorQuadrantId,
  options?: ExplorerFileTabPlacementOptions,
): EditorLayoutMode {
  if (options?.allowExplorerFileSplit === false) {
    return "single";
  }
  if (state.layout !== "single") {
    return state.layout;
  }
  if (targetGroupId === "topLeft") {
    return "single";
  }
  return layoutAfterEnablingHorizontalSplit(state.layout);
}