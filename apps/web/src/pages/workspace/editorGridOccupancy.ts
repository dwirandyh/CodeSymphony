import type { EditorGroup } from "./editorGroups";
import type { EditorLayoutMode, EditorQuadrantId } from "./editorGroupTypes";
import { visibleQuadrantsForLayout } from "./editorGroupTypes";

export type EditorGroupsRecord = Record<EditorQuadrantId, EditorGroup>;

export type EditorGridVisualVariant = "single" | "horizontal";

export function resolveEditorGridVisualVariant(layout: EditorLayoutMode): EditorGridVisualVariant {
  return layout === "single" ? "single" : "horizontal";
}

/** @deprecated Left column full-height grid removed; always false. */
export function gridLeftColumnSpansRows(_groups: EditorGroupsRecord): boolean {
  return false;
}

/** Quadrants that render tab strip + editor pane. */
export function quadrantsWithEditorChrome(layout: EditorLayoutMode): EditorQuadrantId[] {
  return visibleQuadrantsForLayout(layout);
}