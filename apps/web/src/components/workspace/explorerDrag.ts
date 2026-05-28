import type { FileEntry } from "@codesymphony/shared-types";

export const EXPLORER_ENTRY_DRAG_MIME = "application/x-codesymphony-explorer-entry";

export type ExplorerEntryDragPayload = {
  path: string;
  type: FileEntry["type"];
};

function isExplorerEntryType(type: unknown): type is FileEntry["type"] {
  return type === "file" || type === "directory";
}

export function writeExplorerEntryDragData(dataTransfer: DataTransfer, entry: FileEntry): void {
  const payload: ExplorerEntryDragPayload = {
    path: entry.path,
    type: entry.type,
  };

  dataTransfer.setData(EXPLORER_ENTRY_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.setData("text/plain", entry.path);
  dataTransfer.effectAllowed = "copy";
}

export function hasExplorerEntryDragData(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes(EXPLORER_ENTRY_DRAG_MIME);
}

export function readExplorerEntryDragData(dataTransfer: DataTransfer | null): ExplorerEntryDragPayload | null {
  if (!dataTransfer || !hasExplorerEntryDragData(dataTransfer)) {
    return null;
  }

  try {
    const payload = JSON.parse(dataTransfer.getData(EXPLORER_ENTRY_DRAG_MIME)) as Partial<ExplorerEntryDragPayload>;
    if (typeof payload.path !== "string" || payload.path.trim().length === 0 || !isExplorerEntryType(payload.type)) {
      return null;
    }

    return {
      path: payload.path,
      type: payload.type,
    };
  } catch {
    return null;
  }
}
