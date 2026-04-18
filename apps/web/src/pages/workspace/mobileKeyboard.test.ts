import { describe, expect, it } from "vitest";
import {
  computeMobileKeyboardState,
  createMobileKeyboardBaseline,
  isEditableElement,
  type MobileKeyboardSnapshot,
} from "./mobileKeyboard";

function makeSnapshot(overrides: Partial<MobileKeyboardSnapshot> = {}): MobileKeyboardSnapshot {
  return {
    activeElement: null,
    layoutHeight: 900,
    layoutWidth: 390,
    virtualKeyboardHeight: 0,
    visualHeight: 900,
    visualOffsetTop: 0,
    visualWidth: 390,
    ...overrides,
  };
}

describe("mobileKeyboard", () => {
  it("treats inputs, textareas, and contenteditable nodes as editable", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editableDiv = document.createElement("div");
    editableDiv.contentEditable = "true";

    expect(isEditableElement(input)).toBe(true);
    expect(isEditableElement(textarea)).toBe(true);
    expect(isEditableElement(editableDiv)).toBe(true);
    expect(isEditableElement(document.createElement("button"))).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });

  it("hides mobile keyboard state on desktop widths", () => {
    const snapshot = makeSnapshot({
      layoutWidth: 1280,
      visualWidth: 1280,
      layoutHeight: 720,
      visualHeight: 720,
    });

    const state = computeMobileKeyboardState({
      baseline: createMobileKeyboardBaseline(snapshot),
      snapshot,
    });

    expect(state.activeIsEditable).toBe(false);
    expect(state.bottomInsetPx).toBe(0);
    expect(state.measuredVisible).toBe(false);
    expect(state.offsetPx).toBe(0);
    expect(state.baseline).toEqual(createMobileKeyboardBaseline(snapshot));
  });

  it("detects the keyboard from visual viewport shrink when an editable is focused", () => {
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    const baseline = createMobileKeyboardBaseline(makeSnapshot());

    const state = computeMobileKeyboardState({
      baseline,
      snapshot: makeSnapshot({
        activeElement: editable,
        visualHeight: 620,
      }),
    });

    expect(state.activeIsEditable).toBe(true);
    expect(state.bottomInsetPx).toBe(280);
    expect(state.measuredVisible).toBe(true);
    expect(state.offsetPx).toBe(280);
  });

  it("reduces fixed bottom inset when visual viewport offset changes during editor scrolling", () => {
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    const baseline = createMobileKeyboardBaseline(makeSnapshot());

    const state = computeMobileKeyboardState({
      baseline,
      snapshot: makeSnapshot({
        activeElement: editable,
        visualHeight: 620,
        visualOffsetTop: 280,
      }),
    });

    expect(state.activeIsEditable).toBe(true);
    expect(state.bottomInsetPx).toBe(0);
    expect(state.measuredVisible).toBe(true);
    expect(state.offsetPx).toBe(280);
  });

  it("detects the keyboard from layout viewport shrink when visual viewport does not change", () => {
    const textarea = document.createElement("textarea");
    const baseline = createMobileKeyboardBaseline(makeSnapshot());

    const state = computeMobileKeyboardState({
      baseline,
      snapshot: makeSnapshot({
        activeElement: textarea,
        layoutHeight: 640,
      }),
    });

    expect(state.activeIsEditable).toBe(true);
    expect(state.bottomInsetPx).toBe(260);
    expect(state.measuredVisible).toBe(true);
    expect(state.offsetPx).toBe(260);
  });

  it("keeps zero measured offset when the browser does not report keyboard geometry", () => {
    const input = document.createElement("input");
    const baseline = createMobileKeyboardBaseline(makeSnapshot());

    const state = computeMobileKeyboardState({
      baseline,
      snapshot: makeSnapshot({
        activeElement: input,
      }),
    });

    expect(state.activeIsEditable).toBe(true);
    expect(state.bottomInsetPx).toBe(0);
    expect(state.measuredVisible).toBe(false);
    expect(state.offsetPx).toBe(0);
  });
});
