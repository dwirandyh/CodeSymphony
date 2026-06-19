import type { EditorGroupsState } from "./editorGroups";

/** Chat thread shown in the unsplit main pane — follows session selection, then editor active chat tab. */
export function resolveActiveChatThreadIdForUnsplitPane(params: {
  splitMode: boolean;
  editorGroups: EditorGroupsState;
  selectedThreadId: string | null;
}): string | null {
  if (params.splitMode) {
    return params.selectedThreadId;
  }

  const topLeft = params.editorGroups.groups.topLeft;
  const selectedId = params.selectedThreadId;
  if (
    selectedId
    && topLeft.tabs.some((tab) => tab.type === "chat" && tab.id === selectedId)
  ) {
    return selectedId;
  }

  const activeTab = topLeft.tabs.find((tab) => tab.id === topLeft.activeTabId) ?? null;
  if (activeTab?.type === "chat") {
    return activeTab.id;
  }

  return null;
}

export function resolveRequestedThreadIdForChatSession(params: {
  desiredThreadId: string | null | undefined;
  userIntentThreadId: string | null | undefined;
  selectionDeferred: boolean;
}): string | null {
  if (params.selectionDeferred) {
    return null;
  }

  if (params.userIntentThreadId !== undefined) {
    return params.userIntentThreadId;
  }

  return params.desiredThreadId ?? null;
}