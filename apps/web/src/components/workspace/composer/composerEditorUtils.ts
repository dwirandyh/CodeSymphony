import type { FileEntry } from "@codesymphony/shared-types";

type TriggerState = {
  active: boolean;
  query: string;
  startOffset: number;
  anchorNode: Node | null;
};

export type MentionState = TriggerState;

type SlashCommandState = TriggerState;

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
      } else if (node.dataset.slashCommand) {
        text += `/${node.dataset.slashCommand}`;
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

function inactiveTriggerState(): TriggerState {
  return { active: false, query: "", startOffset: -1, anchorNode: null };
}

function detectTriggerInEditor(el: HTMLElement, trigger: "@" | "/"): TriggerState {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
    return inactiveTriggerState();
  }

  const anchorNode = sel.anchorNode;
  if (!anchorNode || anchorNode.nodeType !== Node.TEXT_NODE) {
    return inactiveTriggerState();
  }

  const text = anchorNode.textContent ?? "";
  const cursorOffset = sel.anchorOffset;
  const textBeforeCursor = text.slice(0, cursorOffset);

  const triggerIndex = textBeforeCursor.lastIndexOf(trigger);
  if (triggerIndex === -1) {
    return inactiveTriggerState();
  }

  if (triggerIndex > 0 && !/\s/.test(textBeforeCursor[triggerIndex - 1])) {
    return inactiveTriggerState();
  }

  const query = textBeforeCursor.slice(triggerIndex + 1);
  if (/\s/.test(query) && query.trim().includes(" ")) {
    return inactiveTriggerState();
  }

  return { active: true, query: query.trimEnd(), startOffset: triggerIndex, anchorNode };
}

export function detectMentionInEditor(el: HTMLElement): MentionState {
  return detectTriggerInEditor(el, "@");
}

export function detectSlashCommandInEditor(el: HTMLElement): SlashCommandState {
  return detectTriggerInEditor(el, "/");
}

export const FILE_ICON_SVG =
  '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13H8"/><path d="M16 17H8"/><path d="M16 13h-2"/>';

export const FOLDER_ICON_SVG =
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>';

export const PAPERCLIP_ICON_SVG =
  '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>';
