import { describe, expect, it } from "vitest";
import type { FileEntry } from "@codesymphony/shared-types";
import { buildQuickFileItems, filterQuickFileItems } from "./quickFilePickerUtils";

describe("quickFilePickerUtils", () => {
  const entries: FileEntry[] = [
    { path: "apps/web/src/pages/WorkspacePage.tsx", type: "file" },
    { path: "apps/web/src/components/workspace/CodeEditorPanel.tsx", type: "file" },
    { path: "apps/web/src/components/workspace", type: "directory" },
    { path: "packages/shared-types/src/workflow.ts", type: "file" },
  ];

  it("builds quick file items from file entries only", () => {
    expect(buildQuickFileItems(entries)).toEqual([
      {
        path: "apps/web/src/components/workspace/CodeEditorPanel.tsx",
        name: "CodeEditorPanel.tsx",
        directory: "apps/web/src/components/workspace",
      },
      {
        path: "apps/web/src/pages/WorkspacePage.tsx",
        name: "WorkspacePage.tsx",
        directory: "apps/web/src/pages",
      },
      {
        path: "packages/shared-types/src/workflow.ts",
        name: "workflow.ts",
        directory: "packages/shared-types/src",
      },
    ]);
  });

  it("filters files by fuzzy path and filename", () => {
    const items = buildQuickFileItems(entries);

    expect(filterQuickFileItems(items, "workspace")).toEqual([
      expect.objectContaining({ path: "apps/web/src/pages/WorkspacePage.tsx" }),
      expect.objectContaining({ path: "apps/web/src/components/workspace/CodeEditorPanel.tsx" }),
    ]);

    expect(filterQuickFileItems(items, "workflow")).toEqual([
      expect.objectContaining({ path: "packages/shared-types/src/workflow.ts" }),
    ]);
  });
});
