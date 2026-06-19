import { describe, expect, it } from "vitest";
import { createEmptyEditorGroupsState } from "./editorGroups";
import {
  buildWorkspaceTabSurfaceDiagnostic,
  detectWorkspaceTabSurfaceDesync,
  workspaceTabSurfaceDiagnosticSignature,
} from "./workspaceTabSurfaceDiagnostics";

describe("buildWorkspaceTabSurfaceDiagnostic", () => {
  it("captures desync between route thread and editor chat tabs", () => {
    const editorGroups = createEmptyEditorGroupsState();
    editorGroups.groups.topLeft = {
      tabs: [{ type: "file", id: "a.ts" }],
      activeTabId: "a.ts",
    };

    const diagnostic = buildWorkspaceTabSurfaceDiagnostic({
      routeThreadId: "thread-stale",
      routeView: "chat",
      sessionSelectedThreadId: "thread-stale",
      editorGroups,
      openChatTabCount: 0,
      showWorkspaceEmptyState: true,
      messageListEmptyState: "loading-thread",
      landingHold: false,
    });

    expect(diagnostic.unsplitChatPaneThreadId).toBe(null);
    expect(diagnostic.editorTopLeftChatTabIds).toEqual([]);
    expect(diagnostic.routeThreadId).toBe("thread-stale");
    expect(workspaceTabSurfaceDiagnosticSignature(diagnostic)).toContain("thread-stale");
    expect(detectWorkspaceTabSurfaceDesync(diagnostic)).toBe(true);
  });

  it("flags editor strip highlight drift while session and pane follow the selected thread", () => {
    const editorGroups = createEmptyEditorGroupsState();
    editorGroups.groups.topLeft = {
      tabs: [
        { type: "chat", id: "thread-a" },
        { type: "chat", id: "thread-b" },
      ],
      activeTabId: "thread-a",
    };

    const diagnostic = buildWorkspaceTabSurfaceDiagnostic({
      routeThreadId: "thread-b",
      routeView: null,
      sessionSelectedThreadId: "thread-b",
      editorGroups,
      openChatTabCount: 2,
      showWorkspaceEmptyState: false,
      messageListEmptyState: null,
      landingHold: false,
    });

    expect(diagnostic.unsplitChatPaneThreadId).toBe("thread-b");
    expect(detectWorkspaceTabSurfaceDesync(diagnostic)).toBe(true);
  });
});