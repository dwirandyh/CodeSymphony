import type { EditorGroupsState } from "./editorGroups";
import { resolveUnsplitChatPaneThreadId } from "./unsplitChatSurface";

export type WorkspaceTabSurfaceDiagnostic = {
  routeThreadId: string | null;
  routeView: string | null;
  sessionSelectedThreadId: string | null;
  unsplitChatPaneThreadId: string | null;
  editorTopLeftActiveTabId: string | null;
  editorTopLeftChatTabIds: string[];
  openChatTabCount: number;
  splitMode: boolean;
  showWorkspaceEmptyState: boolean;
  messageListEmptyState: string | null;
  landingHold: boolean;
};

export function buildWorkspaceTabSurfaceDiagnostic(params: {
  routeThreadId: string | null | undefined;
  routeView: string | null | undefined;
  sessionSelectedThreadId: string | null;
  editorGroups: EditorGroupsState;
  openChatTabCount: number;
  showWorkspaceEmptyState: boolean;
  messageListEmptyState: string | null;
  landingHold: boolean;
}): WorkspaceTabSurfaceDiagnostic {
  const topLeft = params.editorGroups.groups.topLeft;
  const unsplitChatPaneThreadId = resolveUnsplitChatPaneThreadId({
    splitMode: params.editorGroups.splitMode,
    editorGroups: params.editorGroups,
    selectedThreadId: params.sessionSelectedThreadId,
  });

  return {
    routeThreadId: params.routeThreadId ?? null,
    routeView: params.routeView ?? null,
    sessionSelectedThreadId: params.sessionSelectedThreadId,
    unsplitChatPaneThreadId,
    editorTopLeftActiveTabId: topLeft.activeTabId,
    editorTopLeftChatTabIds: topLeft.tabs.filter((tab) => tab.type === "chat").map((tab) => tab.id),
    openChatTabCount: params.openChatTabCount,
    splitMode: params.editorGroups.splitMode,
    showWorkspaceEmptyState: params.showWorkspaceEmptyState,
    messageListEmptyState: params.messageListEmptyState,
    landingHold: params.landingHold,
  };
}

export function workspaceTabSurfaceDiagnosticSignature(
  diagnostic: WorkspaceTabSurfaceDiagnostic,
): string {
  return JSON.stringify(diagnostic);
}

export function detectWorkspaceTabSurfaceDesync(
  diagnostic: WorkspaceTabSurfaceDiagnostic,
): boolean {
  if (diagnostic.splitMode) {
    return false;
  }

  if (
    diagnostic.openChatTabCount === 0
    && (diagnostic.routeThreadId != null || diagnostic.sessionSelectedThreadId != null)
  ) {
    return true;
  }

  const activeId = diagnostic.editorTopLeftActiveTabId;
  const activeIsChat =
    activeId != null && diagnostic.editorTopLeftChatTabIds.includes(activeId);

  if (activeIsChat) {
    if (diagnostic.unsplitChatPaneThreadId !== activeId) {
      return true;
    }
    if (
      diagnostic.sessionSelectedThreadId != null
      && diagnostic.sessionSelectedThreadId !== activeId
    ) {
      return true;
    }
    if (diagnostic.routeThreadId != null && diagnostic.routeThreadId !== activeId) {
      return true;
    }
  }

  if (
    diagnostic.unsplitChatPaneThreadId != null
    && diagnostic.sessionSelectedThreadId != null
    && diagnostic.unsplitChatPaneThreadId !== diagnostic.sessionSelectedThreadId
  ) {
    return true;
  }

  return false;
}