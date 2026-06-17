import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_TAB_DRAG_MIME } from "./editorTabDrag";
import { createEmptyEditorGroupsState } from "../../pages/workspace/editorGroups";
import { EditorPaneDropOverlay } from "./EditorPaneDropOverlay";

const emptyGroups = createEmptyEditorGroupsState().groups;

function dispatchDragEvent(
  target: HTMLElement,
  type: "dragover" | "drop",
  clientX: number,
  clientY: number,
  dataTransfer: DataTransfer,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "clientY", { value: clientY });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
}

function createDataTransferStub(): DataTransfer {
  const values = new Map<string, string>();
  const types: string[] = [];
  return {
    types,
    effectAllowed: "none",
    dropEffect: "none",
    setData(type: string, value: string) {
      values.set(type, value);
      if (!types.includes(type)) {
        types.push(type);
      }
    },
    getData(type: string) {
      return values.get(type) ?? "";
    },
  } as unknown as DataTransfer;
}

const mockRect = (): DOMRect =>
  ({
    left: 0,
    width: 400,
    top: 0,
    height: 400,
    right: 400,
    bottom: 400,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  }) as DOMRect;

describe("EditorPaneDropOverlay", () => {
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

  it("shows right-edge highlight on dragover when single layout", () => {
    const onDrop = vi.fn();
    act(() => {
      root.render(
        <div style={{ position: "relative", width: 400, height: 400 }}>
          <EditorPaneDropOverlay layout="single" paneGroupId="topLeft" groups={emptyGroups} tabDragActive onDrop={onDrop} />
        </div>,
      );
    });

    const overlay = container.querySelector('[data-testid="editor-pane-drop-overlay-topLeft"]') as HTMLElement;
    const hitTarget = overlay.querySelector('[data-testid="editor-pane-drop-hit-right"]') as HTMLElement;
    overlay.getBoundingClientRect = mockRect;

    const dataTransfer = createDataTransferStub();
    dataTransfer.setData(
      EDITOR_TAB_DRAG_MIME,
      JSON.stringify({
        sourceGroupId: "topLeft",
        tab: { type: "file", id: "a.ts" },
      }),
    );

    act(() => {
      dispatchDragEvent(hitTarget, "dragover", 350, 200, dataTransfer);
    });

    expect(container.querySelector('[data-testid="editor-pane-drop-highlight-right"]')).not.toBeNull();
  });

  it("calls onDrop with split-right when dropped in the right band", () => {
    const onDrop = vi.fn();
    act(() => {
      root.render(
        <div style={{ position: "relative", width: 400, height: 400 }}>
          <EditorPaneDropOverlay layout="single" paneGroupId="topLeft" groups={emptyGroups} tabDragActive onDrop={onDrop} />
        </div>,
      );
    });

    const overlay = container.querySelector('[data-testid="editor-pane-drop-overlay-topLeft"]') as HTMLElement;
    const hitTarget = overlay.querySelector('[data-testid="editor-pane-drop-hit-right"]') as HTMLElement;
    overlay.getBoundingClientRect = mockRect;

    const dataTransfer = createDataTransferStub();
    dataTransfer.setData(
      EDITOR_TAB_DRAG_MIME,
      JSON.stringify({
        sourceGroupId: "topLeft",
        tab: { type: "file", id: "a.ts" },
      }),
    );

    act(() => {
      dispatchDragEvent(hitTarget, "drop", 350, 200, dataTransfer);
    });

    expect(onDrop).toHaveBeenCalledWith({ type: "file", id: "a.ts" }, "split-right");
  });
});