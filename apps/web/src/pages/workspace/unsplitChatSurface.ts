import type { EditorGroupsState } from "./editorGroups";
import { resolveActiveChatThreadIdForUnsplitPane } from "./resolveActiveChatThreadId";

/** Unsplit main chat pane: editor topLeft active chat tab, else session selection. */
export function resolveUnsplitChatPaneThreadId(params: {
  splitMode: boolean;
  editorGroups: EditorGroupsState;
  selectedThreadId: string | null;
}): string | null {
  return resolveActiveChatThreadIdForUnsplitPane(params);
}