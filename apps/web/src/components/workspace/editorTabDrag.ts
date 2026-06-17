import type { TabItem, TabType } from "../../pages/workspace/editorGroups";
import type { EditorQuadrantId } from "../../pages/workspace/editorGroupTypes";
import { isEditorQuadrantId, migrateLegacyGroupId } from "../../pages/workspace/editorGroupTypes";

export const EDITOR_TAB_DRAG_MIME = "application/x-codesymphony-editor-tab";

/** Browsers hide custom MIME in dragover; use this + hasEditorTabDragData until drop. */
let activeEditorTabDragPayload: EditorTabDragPayload | null = null;

export function setActiveEditorTabDragPayload(payload: EditorTabDragPayload | null): void {
  activeEditorTabDragPayload = payload;
}

export function peekActiveEditorTabDragPayload(): EditorTabDragPayload | null {
  return activeEditorTabDragPayload;
}

export type EditorTabDragPayload = {
  sourceGroupId: EditorQuadrantId;
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

function parseGroupId(value: unknown): EditorQuadrantId | null {
  if (isEditorQuadrantId(value)) {
    return value;
  }
  if (value === "left" || value === "right") {
    return migrateLegacyGroupId(value);
  }
  return null;
}

export function writeEditorTabDragData(
  dataTransfer: DataTransfer,
  payload: EditorTabDragPayload,
): void {
  setActiveEditorTabDragPayload(payload);
  dataTransfer.setData(EDITOR_TAB_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.effectAllowed = "move";
}

export function clearActiveEditorTabDragPayload(): void {
  setActiveEditorTabDragPayload(null);
}

export function hasEditorTabDragData(dataTransfer: DataTransfer | null): boolean {
  if (activeEditorTabDragPayload !== null) {
    return true;
  }
  return Array.from(dataTransfer?.types ?? []).includes(EDITOR_TAB_DRAG_MIME);
}

export function readEditorTabDragData(
  dataTransfer: DataTransfer | null,
): EditorTabDragPayload | null {
  if (!dataTransfer || !hasEditorTabDragData(dataTransfer)) {
    return null;
  }

  const fromSession = peekActiveEditorTabDragPayload();
  if (fromSession) {
    return fromSession;
  }

  try {
    const raw = JSON.parse(dataTransfer.getData(EDITOR_TAB_DRAG_MIME)) as {
      sourceGroupId?: unknown;
      sourceIndex?: unknown;
      tab?: { type?: unknown; id?: unknown };
    };

    const sourceGroupId = parseGroupId(raw.sourceGroupId);
    if (!sourceGroupId) return null;
    if (!raw.tab || !isTabType(raw.tab.type) || typeof raw.tab.id !== "string" || raw.tab.id.length === 0) {
      return null;
    }

    const sourceIndex = typeof raw.sourceIndex === "number" && Number.isInteger(raw.sourceIndex)
      ? raw.sourceIndex
      : undefined;

    return {
      sourceGroupId,
      ...(sourceIndex !== undefined ? { sourceIndex } : {}),
      tab: { type: raw.tab.type, id: raw.tab.id },
    };
  } catch {
    return null;
  }
}