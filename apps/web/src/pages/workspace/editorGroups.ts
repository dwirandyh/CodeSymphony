export type TabType = "chat" | "terminal" | "review" | "file";

export interface TabItem {
  type: TabType;
  id: string; // threadId, terminalTabId, "review", or filePath
}

export interface EditorGroup {
  tabs: TabItem[];
  activeTabId: string | null;
}

export interface EditorGroupsState {
  splitMode: boolean;
  activeGroupId: "left" | "right";
  left: EditorGroup;
  right: EditorGroup;
}

export function reconcileEditorGroups(
  state: EditorGroupsState,
  sourceTabs: TabItem[]
): EditorGroupsState {
  const sourceMap = new Map(sourceTabs.map((t) => [t.id, t]));

  // 1. Filter out tabs no longer in source
  let leftTabs = state.left.tabs.filter((t) => sourceMap.has(t.id));
  let rightTabs = state.right.tabs.filter((t) => sourceMap.has(t.id));

  // 2. Find new tabs not in either group
  const existingIds = new Set([
    ...leftTabs.map((t) => t.id),
    ...rightTabs.map((t) => t.id),
  ]);
  const newTabs = sourceTabs.filter((t) => !existingIds.has(t.id));

  // 3. Add new tabs to the active group
  let activeGroupId = state.activeGroupId;
  if (activeGroupId === "left") {
    leftTabs = [...leftTabs, ...newTabs];
  } else {
    rightTabs = [...rightTabs, ...newTabs];
  }

  // 4. Resolve active tabs for both groups
  let leftActiveId = state.left.activeTabId;
  if (leftActiveId === null || !leftTabs.some((t) => t.id === leftActiveId)) {
    leftActiveId = leftTabs.length > 0 ? leftTabs[0].id : null;
  }

  let rightActiveId = state.right.activeTabId;
  if (rightActiveId === null || !rightTabs.some((t) => t.id === rightActiveId)) {
    rightActiveId = rightTabs.length > 0 ? rightTabs[0].id : null;
  }

  // 5. Handle empty groups and splitMode
  let splitMode = state.splitMode;
  if (leftTabs.length === 0 && rightTabs.length > 0) {
    // Merge right to left
    leftTabs = rightTabs;
    leftActiveId = rightActiveId;
    rightTabs = [];
    rightActiveId = null;
    splitMode = false;
    activeGroupId = "left";
  } else if (rightTabs.length === 0) {
    splitMode = false;
    activeGroupId = "left";
    rightActiveId = null;
  }

  return {
    splitMode,
    activeGroupId,
    left: {
      tabs: leftTabs,
      activeTabId: leftActiveId,
    },
    right: {
      tabs: rightTabs,
      activeTabId: rightActiveId,
    },
  };
}

export function moveTab(
  state: EditorGroupsState,
  tabId: string,
  targetGroupId: "left" | "right"
): EditorGroupsState {
  const sourceGroupId = targetGroupId === "left" ? "right" : "left";
  const sourceGroup = state[sourceGroupId];
  const targetGroup = state[targetGroupId];

  const tabToMove = sourceGroup.tabs.find((t) => t.id === tabId);
  if (!tabToMove) {
    return state;
  }

  const nextSourceTabs = sourceGroup.tabs.filter((t) => t.id !== tabId);
  const nextTargetTabs = [...targetGroup.tabs, tabToMove];

  let nextSourceActiveId = sourceGroup.activeTabId;
  if (nextSourceActiveId === tabId) {
    nextSourceActiveId = nextSourceTabs.length > 0 ? nextSourceTabs[nextSourceTabs.length - 1].id : null;
  }

  const nextTargetActiveId = tabId;

  const nextState: EditorGroupsState = {
    ...state,
    splitMode: true,
    activeGroupId: targetGroupId,
    [sourceGroupId]: {
      tabs: nextSourceTabs,
      activeTabId: nextSourceActiveId,
    },
    [targetGroupId]: {
      tabs: nextTargetTabs,
      activeTabId: nextTargetActiveId,
    },
  };

  // Re-run empty group consolidation
  return reconcileEditorGroups(nextState, [...nextSourceTabs, ...nextTargetTabs]);
}

export function splitActiveTab(state: EditorGroupsState): EditorGroupsState {
  const currentGroup = state[state.activeGroupId];
  if (!currentGroup.activeTabId) {
    // Nothing to split — no active tab in current group
    return state;
  }

  const opposingGroupId = state.activeGroupId === "left" ? "right" : "left";
  return moveTab(state, currentGroup.activeTabId, opposingGroupId);
}

export function closeTabInGroup(
  state: EditorGroupsState,
  tabId: string,
  groupId: "left" | "right"
): { nextState: EditorGroupsState; shouldCloseInHook: boolean } {
  // Removing from group implies closing it in the workspace
  const group = state[groupId];
  const nextTabs = group.tabs.filter((t) => t.id !== tabId);

  let nextActiveId = group.activeTabId;
  if (nextActiveId === tabId) {
    nextActiveId = nextTabs.length > 0 ? nextTabs[nextTabs.length - 1].id : null;
  }

  const tempState: EditorGroupsState = {
    ...state,
    [groupId]: {
      tabs: nextTabs,
      activeTabId: nextActiveId,
    },
  };

  const remainingTabs = [...tempState.left.tabs, ...tempState.right.tabs];
  const reconciled = reconcileEditorGroups(tempState, remainingTabs);

  return {
    nextState: reconciled,
    shouldCloseInHook: true,
  };
}

/**
 * Moves a tab to a target group regardless of which group currently owns it.
 *
 * Unlike {@link moveTab}, this helper does not assume the source group is the
 * opposite of the target — it locates the tab by id. Dropping a tab onto its
 * own group is treated as a no-op so drag-and-drop within the same pane keeps
 * the existing state stable.
 */
export function moveTabToGroup(
  state: EditorGroupsState,
  tabId: string,
  targetGroupId: "left" | "right",
): EditorGroupsState {
  const sourceGroupId: "left" | "right" | null =
    state.left.tabs.some((t) => t.id === tabId)
      ? "left"
      : state.right.tabs.some((t) => t.id === tabId)
        ? "right"
        : null;

  if (sourceGroupId === null) {
    return state;
  }

  if (sourceGroupId === targetGroupId) {
    return state;
  }

  return moveTab(state, tabId, targetGroupId);
}

/**
 * Reorders a tab within its own group by moving it to a target index.
 *
 * Pure: returns the same state reference when the tab is unknown or already at
 * the (clamped) target position, so React state updates can bail out cheaply.
 * The group's {@link EditorGroup.activeTabId} is preserved by identity.
 */
export function reorderTabInGroup(
  state: EditorGroupsState,
  groupId: "left" | "right",
  tabId: string,
  toIndex: number,
): EditorGroupsState {
  const group = state[groupId];
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
    [groupId]: {
      ...group,
      tabs: nextTabs,
    },
  };
}
