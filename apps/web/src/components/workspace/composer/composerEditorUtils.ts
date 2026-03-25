import type { FileEntry } from "@codesymphony/shared-types";

export type MentionState = {
  active: boolean;
  query: string;
  startOffset: number;
  anchorNode: Node | null;
};

export type SlashCommandState = {
  active: boolean;
  query: string;
  startOffset: number;
  anchorNode: Node | null;
};

export type MentionedFile = FileEntry & { id: string };

let mentionIdCounter = 0;
export function nextMentionId(): string {
  mentionIdCounter += 1;
  return `mention-${mentionIdCounter}`;
}

export function fileName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

export function getPlainTextFromEditor(el: HTMLElement): string {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    } else if (node instanceof HTMLElement) {
      if (node.dataset.attachmentId) {
        text += `{{attachment:${node.dataset.attachmentId}}}`;
      } else if (node.dataset.mentionPath) {
        text += `@${node.dataset.mentionPath}`;
      } else if (node.tagName === "BR") {
        text += "\n";
      } else {
        text += node.textContent ?? "";
      }
    }
  }
  return text;
}

export function getMentionedFilesFromEditor(el: HTMLElement): MentionedFile[] {
  const files: MentionedFile[] = [];
  const chips = el.querySelectorAll<HTMLElement>("[data-mention-path]");
  for (const chip of chips) {
    const path = chip.dataset.mentionPath;
    if (path) {
      const type = chip.dataset.mentionType === "directory" ? "directory" : "file";
      files.push({ id: chip.dataset.mentionId ?? nextMentionId(), path, type });
    }
  }
  return files;
}

function detectTokenInEditor(el: HTMLElement, token: "@" | "/"): MentionState {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
    return { active: false, query: "", startOffset: -1, anchorNode: null };
  }

  const anchorNode = sel.anchorNode;
  if (!anchorNode || anchorNode.nodeType !== Node.TEXT_NODE) {
    return { active: false, query: "", startOffset: -1, anchorNode: null };
  }

  const text = anchorNode.textContent ?? "";
  const cursorOffset = sel.anchorOffset;
  const textBeforeCursor = text.slice(0, cursorOffset);

  const tokenIndex = textBeforeCursor.lastIndexOf(token);
  if (tokenIndex === -1) {
    return { active: false, query: "", startOffset: -1, anchorNode: null };
  }

  if (tokenIndex > 0 && !/\s/.test(textBeforeCursor[tokenIndex - 1])) {
    return { active: false, query: "", startOffset: -1, anchorNode: null };
  }

  const query = textBeforeCursor.slice(tokenIndex + 1);
  if (/\s/.test(query) && query.trim().includes(" ")) {
    return { active: false, query: "", startOffset: -1, anchorNode: null };
  }

  return { active: true, query: query.trimEnd(), startOffset: tokenIndex, anchorNode };
}

export function detectMentionInEditor(el: HTMLElement): MentionState {
  return detectTokenInEditor(el, "@");
}

export function detectSlashCommandInEditor(el: HTMLElement): SlashCommandState {
  return detectTokenInEditor(el, "/");
}

export const FILE_ICON_SVG =
  '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13H8"/><path d="M16 17H8"/><path d="M16 13h-2"/>';

export const FOLDER_ICON_SVG =
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>';

export const PAPERCLIP_ICON_SVG =
  '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>';
