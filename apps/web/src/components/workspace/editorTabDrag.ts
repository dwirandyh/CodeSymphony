import type { TabItem, TabType } from "../../pages/workspace/editorGroups";

export const EDITOR_TAB_DRAG_MIME = "application/x-codesymphony-editor-tab";

export type EditorTabDragPayload = {
  sourceGroupId: "left" | "right";
  sourceIndex?: number;
  tab: TabItem;
};

const VALID_TAB_TYPES: ReadonlySet<TabType> = new Set([
  "chat",
  "terminal",
  "review",
  "file",
]);

function isTabType(value: unknown): value is TabType {
  return typeof value === "string" && VALID_TAB_TYPES.has(value as TabType);
}

function isGroupId(value: unknown): value is "left" | "right" {
  return value === "left" || value === "right";
}

export function writeEditorTabDragData(
  dataTransfer: DataTransfer,
  payload: EditorTabDragPayload,
): void {
  dataTransfer.setData(EDITOR_TAB_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.effectAllowed = "move";
}

export function hasEditorTabDragData(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes(EDITOR_TAB_DRAG_MIME);
}

export function readEditorTabDragData(
  dataTransfer: DataTransfer | null,
): EditorTabDragPayload | null {
  if (!dataTransfer || !hasEditorTabDragData(dataTransfer)) {
    return null;
  }

  try {
    const raw = JSON.parse(dataTransfer.getData(EDITOR_TAB_DRAG_MIME)) as {
      sourceGroupId?: unknown;
      sourceIndex?: unknown;
      tab?: { type?: unknown; id?: unknown };
    };

    if (!isGroupId(raw.sourceGroupId)) return null;
    if (!raw.tab || !isTabType(raw.tab.type) || typeof raw.tab.id !== "string" || raw.tab.id.length === 0) {
      return null;
    }

    const sourceIndex = typeof raw.sourceIndex === "number" && Number.isInteger(raw.sourceIndex)
      ? raw.sourceIndex
      : undefined;

    return {
      sourceGroupId: raw.sourceGroupId,
      ...(sourceIndex !== undefined ? { sourceIndex } : {}),
      tab: { type: raw.tab.type, id: raw.tab.id },
    };
  } catch {
    return null;
  }
}
