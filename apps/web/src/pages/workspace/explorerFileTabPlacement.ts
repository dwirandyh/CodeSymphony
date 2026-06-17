import type { EditorLayoutMode, EditorQuadrantId } from "./editorGroupTypes";
import { layoutAfterEnablingHorizontalSplit } from "./editorGroupTypes";

export type ExplorerFileTabPlacementState = {
  layout: EditorLayoutMode;
  activeGroupId: EditorQuadrantId;
  groups: Record<EditorQuadrantId, { tabs: Array<unknown> }>;
};

/** Explorer files always open in the right editor column (append tab if that column already exists). */
export function targetGroupForNewExplorerFileTab(_state: ExplorerFileTabPlacementState): EditorQuadrantId {
  return "topRight";
}

export function layoutAfterPlacingNewFileTab(
  state: ExplorerFileTabPlacementState,
  targetGroupId: EditorQuadrantId,
): EditorLayoutMode {
  if (state.layout !== "single") {
    return state.layout;
  }
  if (targetGroupId === "topLeft") {
    return "single";
  }
  return layoutAfterEnablingHorizontalSplit(state.layout);
}