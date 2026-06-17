import {
  type EditorLayoutMode,
  type EditorQuadrantId,
  EDITOR_QUADRANT_IDS,
  isEditorQuadrantId,
  layoutAfterEnablingHorizontalSplit,
  visibleQuadrantsForLayout,
} from "./editorGroupTypes";

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

/** Fold legacy bottom-row tabs into the top row and clear bottom quadrants. */
function foldBottomRowIntoTop(state: EditorGroupsState): EditorGroupsState {
  const bottomTabs = [
    ...state.groups.bottomLeft.tabs,
    ...state.groups.bottomRight.tabs,
  ];
  if (bottomTabs.length === 0) {
    return state;
  }

  const topLeft = state.groups.topLeft;
  const topRight = state.groups.topRight;
  const mergedTopLeft = [...topLeft.tabs, ...bottomTabs];
  let activeGroupId = state.activeGroupId;
  if (activeGroupId === "bottomLeft" || activeGroupId === "bottomRight") {
    activeGroupId = "topLeft";
  }

  return {
    ...state,
    layout: state.layout === "single" ? "single" : "horizontal",
    activeGroupId,
    groups: {
      ...state.groups,
      topLeft: {
        tabs: mergedTopLeft,
        activeTabId: topLeft.activeTabId ?? bottomTabs[0]?.id ?? null,
      },
      bottomLeft: emptyGroup(),
      bottomRight: emptyGroup(),
    },
  };
}

function collapseEmptyQuadrants(state: EditorGroupsState): EditorGroupsState {
  const folded = foldBottomRowIntoTop(state);
  const visible = visibleQuadrantsForLayout(folded.layout);
  const anyEmptyVisible = visible.some((id) => folded.groups[id].tabs.length === 0);
  if (!anyEmptyVisible || folded.layout === "single") {
    return withSplitModeFlag(folded);
  }

  if (folded.layout === "horizontal") {
    if (folded.groups.topLeft.tabs.length === 0 && folded.groups.topRight.tabs.length > 0) {
      return withSplitModeFlag({
        ...folded,
        layout: "single",
        groups: {
          ...folded.groups,
          topLeft: { ...folded.groups.topRight },
          topRight: emptyGroup(),
        },
        activeGroupId: "topLeft",
      });
    }
    if (folded.groups.topRight.tabs.length === 0) {
      return withSplitModeFlag({ ...folded, layout: "single" });
    }
  }

  return withSplitModeFlag(folded);
}

export function reconcileEditorGroups(
  state: EditorGroupsState,
  sourceTabs: TabItem[],
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
  if (newTabs.length > 0) {
    const active = state.activeGroupId;
    const g = nextRecord[active];
    nextRecord[active] = {
      tabs: [...g.tabs, ...newTabs],
      activeTabId: g.activeTabId ?? newTabs[0]?.id ?? null,
    };
  }

  return collapseEmptyQuadrants({
    ...state,
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
  _sourcePane: EditorQuadrantId,
  edge: "left" | "right",
): EditorQuadrantId {
  return edge === "left" ? "topLeft" : "topRight";
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
  const horizontalTarget: EditorQuadrantId =
    targetQuadrant === "bottomLeft" || targetQuadrant === "bottomRight" ? "topRight" : targetQuadrant;

  const sourceQuadrant = findTabQuadrant(state, tabId);
  if (sourceQuadrant === null) {
    return state;
  }
  if (sourceQuadrant === horizontalTarget) {
    return state;
  }

  const tab = state.groups[sourceQuadrant].tabs.find((t) => t.id === tabId);
  if (!tab) {
    return state;
  }

  const nextLayout =
    layoutOverride ??
    (horizontalTarget === "topRight"
      ? layoutAfterEnablingHorizontalSplit(state.layout)
      : state.layout);
  const sourceGroup = state.groups[sourceQuadrant];
  const targetGroup = state.groups[horizontalTarget];

  const nextSourceTabs = sourceGroup.tabs.filter((t) => t.id !== tabId);
  let nextSourceActive = sourceGroup.activeTabId;
  if (nextSourceActive === tabId) {
    nextSourceActive = nextSourceTabs.length > 0 ? nextSourceTabs[nextSourceTabs.length - 1].id : null;
  }

  const nextTargetTabs = [...targetGroup.tabs, tab];

  const nextState: EditorGroupsState = {
    ...state,
    layout: nextLayout,
    activeGroupId: horizontalTarget,
    groups: {
      ...state.groups,
      [sourceQuadrant]: { tabs: nextSourceTabs, activeTabId: nextSourceActive },
      [horizontalTarget]: { tabs: nextTargetTabs, activeTabId: tabId },
    },
  };

  const remaining = EDITOR_QUADRANT_IDS.flatMap((id) => nextState.groups[id].tabs);
  return reconcileEditorGroups(nextState, remaining);
}

export function moveTabToGroup(
  state: EditorGroupsState,
  tabId: string,
  targetGroupId: EditorQuadrantId,
): EditorGroupsState {
  return moveTabToQuadrant(state, tabId, targetGroupId);
}

export function moveTab(
  state: EditorGroupsState,
  tabId: string,
  targetGroupId: EditorQuadrantId,
): EditorGroupsState {
  const target =
    targetGroupId === "bottomLeft" || targetGroupId === "bottomRight" ? "topRight" : targetGroupId;
  const layout =
    target === "topRight" ? layoutAfterEnablingHorizontalSplit(state.layout) : state.layout;
  return moveTabToQuadrant(state, tabId, target, layout);
}

export function splitActiveTab(state: EditorGroupsState): EditorGroupsState {
  const current = state.groups[state.activeGroupId];
  if (!current.activeTabId) {
    return state;
  }
  const tabId = current.activeTabId;
  const layout = layoutAfterEnablingHorizontalSplit(state.layout);
  return moveTabToQuadrant(state, tabId, "topRight", layout);
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
  return ["topLeft", "topRight"];
}

export function bottomHeaderQuadrantsForLayout(_layout: EditorLayoutMode): EditorQuadrantId[] {
  return [];
}

export { isEditorQuadrantId };