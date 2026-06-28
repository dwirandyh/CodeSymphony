import { reconcileEditorGroups, type EditorGroupsState, type TabItem } from "./editorGroups";
import type { ExplorerFileTabPlacementOptions } from "./explorerFileTabPlacement";

export type PrepareEditorGroupsForExplorerFileOpenParams = {
  state: EditorGroupsState;
  sourceTabs: TabItem[];
  filePath: string;
} & ExplorerFileTabPlacementOptions;

/**
 * Apply explorer-file split placement synchronously when opening a file.
 * Without this, URL/search updates to view=file while editorGroups still has
 * layout=single until reconcileEditorGroups runs in useEffect — one frame of
 * full-width file UI before split.
 */
export function prepareEditorGroupsForExplorerFileOpen(
  params: PrepareEditorGroupsForExplorerFileOpenParams,
): EditorGroupsState {
  const { state, sourceTabs, filePath, allowExplorerFileSplit } = params;
  const tabsWithFile = sourceTabs.some((tab) => tab.type === "file" && tab.id === filePath)
    ? sourceTabs
    : [...sourceTabs, { type: "file" as const, id: filePath }];

  const alreadyPlaced =
    state.layout !== "single"
    && state.groups.topRight.tabs.some((tab) => tab.id === filePath);
  if (alreadyPlaced) {
    return state;
  }

  return reconcileEditorGroups(state, tabsWithFile, {
    newFileTabIds: [filePath],
    allowExplorerFileSplit,
  });
}