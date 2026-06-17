import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyEditorGroupsState } from "../../pages/workspace/editorGroups";
import { EditorSurfaceFrame } from "./EditorSurfaceFrame";

const emptyGroups = createEmptyEditorGroupsState().groups;

describe("EditorSurfaceFrame", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not mount pane drop overlay when paneDropEnabled is false", () => {
    act(() => {
      root.render(
        <EditorSurfaceFrame
          paneGroupId="topLeft"
          layout="horizontal"
          groups={emptyGroups}
          paneDropEnabled={false}
          onPaneDrop={vi.fn()}
        >
          <button type="button" data-testid="child-button">
            click
          </button>
        </EditorSurfaceFrame>,
      );
    });

    expect(container.querySelector('[data-testid="editor-pane-drop-overlay-topLeft"]')).toBeNull();
  });

  it("mounts overlay hit layer as pointer-events-none until tabDragActive", () => {
    act(() => {
      root.render(
        <EditorSurfaceFrame
          paneGroupId="bottomRight"
          layout="horizontal"
          groups={emptyGroups}
          tabDragActive={false}
          onPaneDrop={vi.fn()}
        >
          <button type="button" data-testid="child-button">
            click
          </button>
        </EditorSurfaceFrame>,
      );
    });

    const overlay = container.querySelector('[data-testid="editor-pane-drop-overlay-bottomRight"]');
    expect(overlay).not.toBeNull();
    const hit = overlay?.querySelector('[data-testid="editor-pane-drop-hit"]') as HTMLElement | null;
    expect(hit?.className).toContain("pointer-events-none");
  });
});