import { describe, expect, it } from "vitest";
import {
  gridLeftColumnSpansRows,
  quadrantsWithEditorChrome,
  resolveEditorGridVisualVariant,
} from "./editorGridOccupancy";
import { createEmptyEditorGroupsState } from "./editorGroups";

describe("horizontal-only editor chrome", () => {
  it("gridLeftColumnSpansRows is always false", () => {
    const base = createEmptyEditorGroupsState();
    expect(gridLeftColumnSpansRows(base.groups)).toBe(false);
  });

  it("resolveEditorGridVisualVariant mirrors layout", () => {
    expect(resolveEditorGridVisualVariant("single")).toBe("single");
    expect(resolveEditorGridVisualVariant("horizontal")).toBe("horizontal");
  });

  it("quadrantsWithEditorChrome matches visible panes", () => {
    expect(quadrantsWithEditorChrome("single")).toEqual(["topLeft"]);
    expect(quadrantsWithEditorChrome("horizontal")).toEqual(["topLeft", "topRight"]);
  });
});