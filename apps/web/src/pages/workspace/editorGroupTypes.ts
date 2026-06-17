export type EditorQuadrantId = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

/** Editor split is left/right only (no vertical or 2×2 grid). */
export type EditorLayoutMode = "single" | "horizontal";

export const EDITOR_QUADRANT_IDS: readonly EditorQuadrantId[] = [
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomRight",
] as const;

export function isEditorQuadrantId(value: unknown): value is EditorQuadrantId {
  return typeof value === "string" && (EDITOR_QUADRANT_IDS as readonly string[]).includes(value);
}

/** Legacy alias: horizontal split used left/right in the header. */
export function migrateLegacyGroupId(value: "left" | "right" | EditorQuadrantId): EditorQuadrantId {
  if (value === "left") return "topLeft";
  if (value === "right") return "topRight";
  return value;
}

export function visibleQuadrantsForLayout(layout: EditorLayoutMode): EditorQuadrantId[] {
  switch (layout) {
    case "single":
      return ["topLeft"];
    case "horizontal":
      return ["topLeft", "topRight"];
  }
}

export function layoutAfterEnablingHorizontalSplit(current: EditorLayoutMode): EditorLayoutMode {
  return current === "single" ? "horizontal" : current;
}