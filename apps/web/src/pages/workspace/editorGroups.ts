import {
  type EditorLayoutMode,
  type EditorQuadrantId,
  EDITOR_QUADRANT_IDS,
  isEditorQuadrantId,
  layoutAfterEnablingHorizontalSplit,
} from "./editorGroupTypes";
import {
  activeColumnIds,
  columnIndex,
  compactEditorColumns,
  firstEmptyColumnToTheRight,
  HORIZONTAL_EDITOR_COLUMN_IDS,
  visibleEditorColumnIds,
} from "./editorColumns";
import {
  layoutAfterPlacingNewFileTab,
  targetGroupForNewExplorerFileTab,
  type ExplorerFileTabPlacementOptions,
} from "./explorerFileTabPlacement";

export type TabType = "chat" | "terminal" | "review" | "file";

export interface TabItem {
  type: TabType;
  id: string;
}

export interface EditorGroup {
  tabs: TabItem[];
  activeTabId: string | null;
}

export type EditorGroupsState = {
  layout: EditorLayoutMode;
  activeGroupId: EditorQuadrantId;
  groups: Record<EditorQuadrantId, EditorGroup>;
  /** @deprecated Use `layout !== "single"`. Kept for header split UI during migration. */
  splitMode: boolean;
};

export function createEmptyEditorGroupsState(): EditorGroupsState {
  const emptyGroup = (): EditorGroup => ({ tabs: [], activeTabId: null });
  return {
    layout: "single",
    activeGroupId: "topLeft",
    splitMode: false,
    groups: {
      topLeft: emptyGroup(),
      topRight: emptyGroup(),
      bottomLeft: emptyGroup(),
      bottomRight: emptyGroup(),
    },
  };
}

export function getEditorGroup(state: EditorGroupsState, id: EditorQuadrantId): EditorGroup {
  return state.groups[id];
}

export function findTabQuadrant(state: EditorGroupsState, tabId: string): EditorQuadrantId | null {
  for (const id of EDITOR_QUADRANT_IDS) {
    if (state.groups[id].tabs.some((t) => t.id === tabId)) {
      return id;
    }
  }
  return null;
}

function withSplitModeFlag(state: EditorGroupsState): EditorGroupsState {
  return {
    ...state,
    splitMode: state.layout !== "single",
  };
}

function emptyGroup(): EditorGroup {
  return { tabs: [], activeTabId: null };
}

function collapseEmptyColumns(state: EditorGroupsState): EditorGroupsState {
  return withSplitModeFlag(compactEditorColumns(state));
}

export type ReconcileEditorGroupsOptions = {
  /** File tab ids newly opened from explorer; routed to right / unfocused pane. */
  newFileTabIds?: readonly string[];
  /**
   * Tab id to activate when it is newly added (chat, terminal, etc.).
   * Keeps the focused pane on a freshly created/selected session tab in both
   * single and split layouts.
   */
  activateTabId?: string | null;
  /**
   * @deprecated Use `activateTabId`. Kept so existing call sites keep working.
   */
  activateChatTabId?: string | null;
} & ExplorerFileTabPlacementOptions;

/**
 * Align the focused pane's active tab with an external session selection.
 * - single layout: always topLeft
 * - split layout: activeGroupId only (does not steal focus from other panes)
 */
export function alignEditorActiveTabWithSelection(
  state: EditorGroupsState,
  selectionTabId: string,
): EditorGroupsState {
  const groupId = state.layout === "single" ? "topLeft" : state.activeGroupId;
  const group = state.groups[groupId];
  if (group.activeTabId === selectionTabId) {
    return state;
  }
  if (!group.tabs.some((tab) => tab.id === selectionTabId)) {
    return state;
  }
  return {
    ...state,
    activeGroupId: groupId,
    groups: {
      ...state.groups,
      [groupId]: { ...group, activeTabId: selectionTabId },
    },
  };
}

export function reconcileEditorGroups(
  state: EditorGroupsState,
  sourceTabs: TabItem[],
  options?: ReconcileEditorGroupsOptions,
): EditorGroupsState {
  const sourceMap = new Map(sourceTabs.map((t) => [t.id, t]));
  const nextRecord = { ...state.groups };

  for (const id of EDITOR_QUADRANT_IDS) {
    const group = state.groups[id];
    const tabs = group.tabs.filter((t) => sourceMap.has(t.id));
    nextRecord[id] = {
      tabs,
      activeTabId:
        group.activeTabId && tabs.some((t) => t.id === group.activeTabId)
          ? group.activeTabId
          : tabs.length > 0
            ? tabs[0].id
            : null,
    };
  }

  const existingIds = new Set<string>();
  for (const id of EDITOR_QUADRANT_IDS) {
    nextRecord[id].tabs.forEach((t) => existingIds.add(t.id));
  }
  const newTabs = sourceTabs.filter((t) => !existingIds.has(t.id));
  if (newTabs.length === 0) {
    return collapseEmptyColumns({
      ...state,
      groups: nextRecord,
    });
  }

  const explorerFileIdSet = new Set(options?.newFileTabIds ?? []);
  const explorerFileTabs = newTabs.filter((t) => t.type === "file" && explorerFileIdSet.has(t.id));
  const otherNewTabs = newTabs.filter((t) => !(t.type === "file" && explorerFileIdSet.has(t.id)));

  let nextLayout = state.layout;
  let nextActiveGroupId = state.activeGroupId;

  if (explorerFileTabs.length > 0) {
    const placementOptions: ExplorerFileTabPlacementOptions = {
      allowExplorerFileSplit: options?.allowExplorerFileSplit,
    };
    const targetGroupId = targetGroupForNewExplorerFileTab(state, placementOptions);
    nextLayout = layoutAfterPlacingNewFileTab(state, targetGroupId, placementOptions);
    const targetGroup = nextRecord[targetGroupId];
    const lastExplorerId = explorerFileTabs[explorerFileTabs.length - 1]?.id ?? null;
    nextRecord[targetGroupId] = {
      tabs: [...targetGroup.tabs, ...explorerFileTabs],
      activeTabId: lastExplorerId,
    };
    nextActiveGroupId = targetGroupId;
  }

  const newTabIdSet = new Set(newTabs.map((t) => t.id));
  const requestedActivateTabId = options?.activateTabId ?? options?.activateChatTabId ?? null;
  const activateTabId =
    requestedActivateTabId && newTabIdSet.has(requestedActivateTabId)
      ? requestedActivateTabId
      : null;

  if (otherNewTabs.length > 0) {
    const active = nextActiveGroupId;
    const g = nextRecord[active];
    nextRecord[active] = {
      tabs: [...g.tabs, ...otherNewTabs],
      activeTabId: activateTabId ?? g.activeTabId ?? otherNewTabs[0]?.id ?? null,
    };
  } else if (explorerFileTabs.length === 0) {
    const active = state.activeGroupId;
    const g = nextRecord[active];
    nextRecord[active] = {
      tabs: [...g.tabs, ...newTabs],
      activeTabId: activateTabId ?? g.activeTabId ?? newTabs[0]?.id ?? null,
    };
  }

  return collapseEmptyColumns({
    ...state,
    layout: nextLayout,
    activeGroupId: nextActiveGroupId,
    groups: nextRecord,
  });
}

export function reorderTabInGroup(
  state: EditorGroupsState,
  groupId: EditorQuadrantId,
  tabId: string,
  toIndex: number,
): EditorGroupsState {
  const group = state.groups[groupId];
  const fromIndex = group.tabs.findIndex((t) => t.id === tabId);
  if (fromIndex === -1) {
    return state;
  }

  const clamped = Math.max(0, Math.min(group.tabs.length - 1, toIndex));
  if (clamped === fromIndex) {
    return state;
  }

  const nextTabs = [...group.tabs];
  const [moved] = nextTabs.splice(fromIndex, 1);
  nextTabs.splice(clamped, 0, moved);

  return {
    ...state,
    groups: {
      ...state.groups,
      [groupId]: {
        ...group,
        tabs: nextTabs,
      },
    },
  };
}

export function destinationForPaneSplit(
  groups: Record<EditorQuadrantId, EditorGroup>,
  sourcePane: EditorQuadrantId,
  edge: "left" | "right",
): EditorQuadrantId {
  if (edge === "left") {
    const idx = columnIndex(sourcePane);
    return idx > 0 ? HORIZONTAL_EDITOR_COLUMN_IDS[idx - 1] : sourcePane;
  }
  const empty = firstEmptyColumnToTheRight(groups, sourcePane);
  if (empty) {
    return empty;
  }
  const idx = columnIndex(sourcePane);
  if (idx < HORIZONTAL_EDITOR_COLUMN_IDS.length - 1) {
    return HORIZONTAL_EDITOR_COLUMN_IDS[idx + 1];
  }
  return sourcePane;
}

export function layoutAfterPaneSplitEdge(
  layout: EditorLayoutMode,
  edge: "left" | "right",
): EditorLayoutMode {
  void edge;
  return layoutAfterEnablingHorizontalSplit(layout);
}

export function moveTabToQuadrant(
  state: EditorGroupsState,
  tabId: string,
  targetQuadrant: EditorQuadrantId,
  layoutOverride?: EditorLayoutMode,
): EditorGroupsState {
  const sourceQuadrant = findTabQuadrant(state, tabId);
  if (sourceQuadrant === null) {
    return state;
  }
  if (sourceQuadrant === targetQuadrant) {
    return state;
  }

  const tab = state.groups[sourceQuadrant].tabs.find((t) => t.id === tabId);
  if (!tab) {
    return state;
  }

  const targetEmpty = state.groups[targetQuadrant].tabs.length === 0;
  const nextLayout =
    layoutOverride ?? (targetEmpty ? layoutAfterEnablingHorizontalSplit(state.layout) : state.layout);
  const sourceGroup = state.groups[sourceQuadrant];
  const targetGroup = state.groups[targetQuadrant];

  const nextSourceTabs = sourceGroup.tabs.filter((t) => t.id !== tabId);
  let nextSourceActive = sourceGroup.activeTabId;
  if (nextSourceActive === tabId) {
    nextSourceActive = nextSourceTabs.length > 0 ? nextSourceTabs[nextSourceTabs.length - 1].id : null;
  }

  const nextTargetTabs = targetEmpty ? [tab] : [...targetGroup.tabs, tab];

  return commitTabMove(
    state,
    sourceQuadrant,
    targetQuadrant,
    nextSourceTabs,
    nextSourceActive,
    nextTargetTabs,
    tabId,
    nextLayout,
  );
}

function insertTabAtIndex(tabs: TabItem[], tab: TabItem, toIndex: number): TabItem[] {
  const clamped = Math.max(0, Math.min(tabs.length, toIndex));
  const next = [...tabs];
  next.splice(clamped, 0, tab);
  return next;
}

function commitTabMove(
  state: EditorGroupsState,
  sourceQuadrant: EditorQuadrantId,
  targetQuadrant: EditorQuadrantId,
  nextSourceTabs: TabItem[],
  nextSourceActive: string | null,
  nextTargetTabs: TabItem[],
  nextTargetActive: string | null,
  nextLayout: EditorLayoutMode,
): EditorGroupsState {
  const nextState: EditorGroupsState = {
    ...state,
    layout: nextLayout,
    activeGroupId: targetQuadrant,
    groups: {
      ...state.groups,
      [sourceQuadrant]: { tabs: nextSourceTabs, activeTabId: nextSourceActive },
      [targetQuadrant]: { tabs: nextTargetTabs, activeTabId: nextTargetActive },
    },
  };

  const remaining = EDITOR_QUADRANT_IDS.flatMap((id) => nextState.groups[id].tabs);
  return reconcileEditorGroups(nextState, remaining);
}

export function moveTabToGroup(
  state: EditorGroupsState,
  tabId: string,
  targetGroupId: EditorQuadrantId,
  toIndex?: number,
): EditorGroupsState {
  const sourceQuadrant = findTabQuadrant(state, tabId);
  if (sourceQuadrant === null) {
    return state;
  }
  if (sourceQuadrant === targetGroupId) {
    return state;
  }

  const tab = state.groups[sourceQuadrant].tabs.find((t) => t.id === tabId);
  if (!tab) {
    return state;
  }

  const targetGroup = state.groups[targetGroupId];
  const targetEmpty = targetGroup.tabs.length === 0;
  const nextLayout = targetEmpty ? layoutAfterEnablingHorizontalSplit(state.layout) : state.layout;
  const sourceGroup = state.groups[sourceQuadrant];

  const nextSourceTabs = sourceGroup.tabs.filter((t) => t.id !== tabId);
  let nextSourceActive = sourceGroup.activeTabId;
  if (nextSourceActive === tabId) {
    nextSourceActive = nextSourceTabs.length > 0 ? nextSourceTabs[nextSourceTabs.length - 1].id : null;
  }

  const nextTargetTabs = targetEmpty
    ? [tab]
    : toIndex !== undefined
      ? insertTabAtIndex(targetGroup.tabs, tab, toIndex)
      : [...targetGroup.tabs, tab];

  return commitTabMove(
    state,
    sourceQuadrant,
    targetGroupId,
    nextSourceTabs,
    nextSourceActive,
    nextTargetTabs,
    tabId,
    nextLayout,
  );
}

export function moveTab(
  state: EditorGroupsState,
  tabId: string,
  targetGroupId: EditorQuadrantId,
): EditorGroupsState {
  const layout =
    state.groups[targetGroupId].tabs.length === 0
      ? layoutAfterEnablingHorizontalSplit(state.layout)
      : state.layout;
  return moveTabToQuadrant(state, tabId, targetGroupId, layout);
}

export function splitActiveTab(state: EditorGroupsState): EditorGroupsState {
  const current = state.groups[state.activeGroupId];
  if (!current.activeTabId) {
    return state;
  }
  const tabId = current.activeTabId;
  const dest =
    firstEmptyColumnToTheRight(state.groups, state.activeGroupId)
    ?? destinationForPaneSplit(state.groups, state.activeGroupId, "right");
  const layout = layoutAfterEnablingHorizontalSplit(state.layout);
  return moveTabToQuadrant(state, tabId, dest, layout);
}

export function closeTabInGroup(
  state: EditorGroupsState,
  tabId: string,
  groupId: EditorQuadrantId,
): { nextState: EditorGroupsState; shouldCloseInHook: boolean } {
  const group = state.groups[groupId];
  const nextTabs = group.tabs.filter((t) => t.id !== tabId);

  let nextActiveId = group.activeTabId;
  if (nextActiveId === tabId) {
    nextActiveId = nextTabs.length > 0 ? nextTabs[nextTabs.length - 1].id : null;
  }

  const tempState: EditorGroupsState = {
    ...state,
    groups: {
      ...state.groups,
      [groupId]: { tabs: nextTabs, activeTabId: nextActiveId },
    },
  };

  const remainingTabs = EDITOR_QUADRANT_IDS.flatMap((id) => tempState.groups[id].tabs);
  const reconciled = reconcileEditorGroups(tempState, remainingTabs);

  return {
    nextState: reconciled,
    shouldCloseInHook: true,
  };
}

/** Header / strip compatibility: primary row uses top row quadrants. */
export function headerQuadrantsForLayout(layout: EditorLayoutMode): EditorQuadrantId[] {
  if (layout === "single") {
    return ["topLeft"];
  }
  return [...HORIZONTAL_EDITOR_COLUMN_IDS];
}

export function bottomHeaderQuadrantsForLayout(_layout: EditorLayoutMode): EditorQuadrantId[] {
  return [];
}

export { activeColumnIds, visibleEditorColumnIds, isEditorQuadrantId };