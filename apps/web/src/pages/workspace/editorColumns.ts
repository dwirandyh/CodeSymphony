import type { EditorQuadrantId } from "./editorGroupTypes";
import type { EditorGroup, EditorGroupsState } from "./editorGroups";

/** Left-to-right editor columns (reuses quadrant ids; bottom row = extra horizontal slots only). */
export const HORIZONTAL_EDITOR_COLUMN_IDS: readonly EditorQuadrantId[] = [
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomRight",
] as const;

export const MAX_EDITOR_COLUMNS = HORIZONTAL_EDITOR_COLUMN_IDS.length;

export function columnIndex(columnId: EditorQuadrantId): number {
  const idx = HORIZONTAL_EDITOR_COLUMN_IDS.indexOf(columnId);
  return idx === -1 ? 0 : idx;
}

export function columnIdAtIndex(index: number): EditorQuadrantId {
  const clamped = Math.max(0, Math.min(MAX_EDITOR_COLUMNS - 1, index));
  return HORIZONTAL_EDITOR_COLUMN_IDS[clamped];
}

export function activeColumnIds(groups: Record<EditorQuadrantId, EditorGroup>): EditorQuadrantId[] {
  return HORIZONTAL_EDITOR_COLUMN_IDS.filter((id) => groups[id].tabs.length > 0);
}

export function defaultColumnWidthPercents(count: number): number[] {
  if (count <= 0) return [];
  const each = 100 / count;
  return Array.from({ length: count }, (_, i) =>
    i === count - 1 ? 100 - each * (count - 1) : each,
  );
}

export function normalizeColumnWidths(widths: number[], count: number): number[] {
  if (count <= 0) return [];
  if (widths.length === count) {
    const sum = widths.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      return widths.map((w) => (w / sum) * 100);
    }
  }
  return defaultColumnWidthPercents(count);
}

/** Pack non-empty columns to the left; clear trailing slots. */
export function compactEditorColumns(state: EditorGroupsState): EditorGroupsState {
  const occupied = activeColumnIds(state.groups);
  if (occupied.length === 0) {
    return {
      ...state,
      layout: "single",
      splitMode: false,
      activeGroupId: "topLeft",
      groups: {
        ...state.groups,
        topLeft: { tabs: [], activeTabId: null },
        topRight: { tabs: [], activeTabId: null },
        bottomLeft: { tabs: [], activeTabId: null },
        bottomRight: { tabs: [], activeTabId: null },
      },
    };
  }

  const emptyGroup = (): EditorGroup => ({ tabs: [], activeTabId: null });
  const nextGroups = {
    topLeft: emptyGroup(),
    topRight: emptyGroup(),
    bottomLeft: emptyGroup(),
    bottomRight: emptyGroup(),
  };

  occupied.forEach((sourceId, index) => {
    const targetId = HORIZONTAL_EDITOR_COLUMN_IDS[index];
    nextGroups[targetId] = { ...state.groups[sourceId] };
  });

  let activeGroupId = state.activeGroupId;
  const priorActiveTabId = state.groups[state.activeGroupId]?.activeTabId;
  if (priorActiveTabId) {
    for (const id of HORIZONTAL_EDITOR_COLUMN_IDS) {
      if (nextGroups[id].tabs.some((t) => t.id === priorActiveTabId)) {
        activeGroupId = id;
        break;
      }
    }
  } else if (!HORIZONTAL_EDITOR_COLUMN_IDS.slice(0, occupied.length).includes(activeGroupId)) {
    activeGroupId = HORIZONTAL_EDITOR_COLUMN_IDS[0];
  }

  const layout = occupied.length > 1 ? "horizontal" : "single";

  return {
    ...state,
    layout,
    splitMode: layout !== "single",
    activeGroupId,
    groups: nextGroups,
  };
}

/** First empty column strictly to the right of `fromColumnId`, or null if at max density. */
export function firstEmptyColumnToTheRight(
  groups: Record<EditorQuadrantId, EditorGroup>,
  fromColumnId: EditorQuadrantId,
): EditorQuadrantId | null {
  const start = columnIndex(fromColumnId) + 1;
  for (let i = start; i < MAX_EDITOR_COLUMNS; i++) {
    const id = HORIZONTAL_EDITOR_COLUMN_IDS[i];
    if (groups[id].tabs.length === 0) {
      return id;
    }
  }
  return null;
}

export function visibleEditorColumnIds(state: EditorGroupsState): EditorQuadrantId[] {
  const count = activeColumnIds(state.groups).length;
  if (count === 0) {
    return ["topLeft"];
  }
  return HORIZONTAL_EDITOR_COLUMN_IDS.slice(0, count) as EditorQuadrantId[];
}