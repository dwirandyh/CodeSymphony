import { describe, expect, it } from "vitest";
import {
  EXPLORER_ENTRY_DRAG_MIME,
  hasExplorerEntryDragData,
  readExplorerEntryDragData,
  writeExplorerEntryDragData,
} from "./explorerDrag";

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

describe("explorerDrag", () => {
  it("writes a custom explorer payload plus text/plain for terminal drops", () => {
    const dataTransfer = createDataTransferStub();

    writeExplorerEntryDragData(dataTransfer, { path: "src/index.ts", type: "file" });

    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(dataTransfer.getData("text/plain")).toBe("src/index.ts");
    expect(JSON.parse(dataTransfer.getData(EXPLORER_ENTRY_DRAG_MIME))).toEqual({
      path: "src/index.ts",
      type: "file",
    });
  });

  it("reads valid file and directory explorer payloads", () => {
    const dataTransfer = createDataTransferStub();
    writeExplorerEntryDragData(dataTransfer, { path: "src/utils", type: "directory" });

    expect(hasExplorerEntryDragData(dataTransfer)).toBe(true);
    expect(readExplorerEntryDragData(dataTransfer)).toEqual({
      path: "src/utils",
      type: "directory",
    });
  });
});
