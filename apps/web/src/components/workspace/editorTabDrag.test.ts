import { describe, expect, it } from "vitest";
import {
  EDITOR_TAB_DRAG_MIME,
  hasEditorTabDragData,
  readEditorTabDragData,
  writeEditorTabDragData,
} from "./editorTabDrag";

function createDataTransferStub() {
  const values = new Map<string, string>();
  const dataTransfer = {
    types: [] as string[],
    effectAllowed: "none",
    setData(type: string, value: string) {
      values.set(type, value);
      if (!this.types.includes(type)) {
        this.types.push(type);
      }
    },
    getData(type: string) {
      return values.get(type) ?? "";
    },
  };

  return dataTransfer as unknown as DataTransfer;
}

describe("editorTabDrag", () => {
  it("writes a tab payload with source group and tab metadata", () => {
    const dataTransfer = createDataTransferStub();

    writeEditorTabDragData(dataTransfer, {
      sourceGroupId: "left",
      tab: { type: "file", id: "src/index.ts" },
    });

    expect(dataTransfer.effectAllowed).toBe("move");
    expect(JSON.parse(dataTransfer.getData(EDITOR_TAB_DRAG_MIME))).toEqual({
      sourceGroupId: "left",
      tab: { type: "file", id: "src/index.ts" },
    });
  });

  it("detects presence of an editor tab payload", () => {
    const dataTransfer = createDataTransferStub();
    expect(hasEditorTabDragData(dataTransfer)).toBe(false);

    writeEditorTabDragData(dataTransfer, {
      sourceGroupId: "right",
      tab: { type: "chat", id: "thread-1" },
    });

    expect(hasEditorTabDragData(dataTransfer)).toBe(true);
  });

  it("reads back a valid payload", () => {
    const dataTransfer = createDataTransferStub();
    writeEditorTabDragData(dataTransfer, {
      sourceGroupId: "right",
      tab: { type: "terminal", id: "term-9" },
    });

    expect(readEditorTabDragData(dataTransfer)).toEqual({
      sourceGroupId: "right",
      tab: { type: "terminal", id: "term-9" },
    });
  });

  it("returns null for unknown source group ids", () => {
    const dataTransfer = createDataTransferStub();
    dataTransfer.setData(
      EDITOR_TAB_DRAG_MIME,
      JSON.stringify({ sourceGroupId: "middle", tab: { type: "file", id: "x" } })
    );

    expect(readEditorTabDragData(dataTransfer)).toBeNull();
  });

  it("returns null for invalid tab type", () => {
    const dataTransfer = createDataTransferStub();
    dataTransfer.setData(
      EDITOR_TAB_DRAG_MIME,
      JSON.stringify({ sourceGroupId: "left", tab: { type: "bogus", id: "x" } })
    );

    expect(readEditorTabDragData(dataTransfer)).toBeNull();
  });

  it("returns null when payload is missing", () => {
    const dataTransfer = createDataTransferStub();
    expect(readEditorTabDragData(dataTransfer)).toBeNull();
  });

  it("round-trips an optional sourceIndex used for in-row reorder", () => {
    const dataTransfer = createDataTransferStub();
    writeEditorTabDragData(dataTransfer, {
      sourceGroupId: "left",
      sourceIndex: 3,
      tab: { type: "file", id: "src/a.ts" },
    });

    expect(readEditorTabDragData(dataTransfer)).toEqual({
      sourceGroupId: "left",
      sourceIndex: 3,
      tab: { type: "file", id: "src/a.ts" },
    });
  });

  it("omits sourceIndex when not provided", () => {
    const dataTransfer = createDataTransferStub();
    writeEditorTabDragData(dataTransfer, {
      sourceGroupId: "left",
      tab: { type: "file", id: "src/a.ts" },
    });

    const payload = readEditorTabDragData(dataTransfer);
    expect(payload?.sourceIndex).toBeUndefined();
  });

  it("ignores a non-numeric sourceIndex", () => {
    const dataTransfer = createDataTransferStub();
    dataTransfer.setData(
      EDITOR_TAB_DRAG_MIME,
      JSON.stringify({ sourceGroupId: "left", sourceIndex: "2", tab: { type: "file", id: "x" } })
    );

    expect(readEditorTabDragData(dataTransfer)?.sourceIndex).toBeUndefined();
  });
});
