import type { FileEntry } from "@codesymphony/shared-types";
import { serializeMention } from "../../../lib/mentions";

type TriggerState = {
  active: boolean;
  query: string;
  startOffset: number;
  anchorNode: Node | null;
};

export type MentionState = TriggerState;

type SlashCommandTrigger = "/" | "$";

type SlashCommandState = TriggerState & {
  trigger: SlashCommandTrigger;
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

const BLOCK_TAG_NAMES = new Set([
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "OL",
  "P",
  "PRE",
  "UL",
]);

function isBlockElement(node: HTMLElement): boolean {
  return BLOCK_TAG_NAMES.has(node.tagName);
}

function getTextFromNode(node: Node, options?: { serializeMentions?: boolean }): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }

  if (!(node instanceof HTMLElement)) {
    return node.textContent ?? "";
  }

  if (node.dataset.attachmentId) {
    return `{{attachment:${node.dataset.attachmentId}}}`;
  }

  if (node.dataset.mentionPath) {
    if (options?.serializeMentions) {
      const type = node.dataset.mentionType === "directory" ? "directory" : "file";
      return serializeMention(node.dataset.mentionPath, type);
    }
    return `@${node.dataset.mentionPath}`;
  }

  if (node.dataset.slashCommand) {
    const trigger = node.dataset.slashCommandTrigger === "$" ? "$" : "/";
    return `${trigger}${node.dataset.slashCommand}`;
  }

  if (node.tagName === "BR") {
    return "\n";
  }

  const text = Array.from(node.childNodes).map((child) => getTextFromNode(child, options)).join("");
  if (!isBlockElement(node)) {
    return text;
  }

  if (text.endsWith("\n")) {
    return text;
  }

  return `${text}\n`;
}

export function getPlainTextFromEditor(el: HTMLElement): string {
  return Array.from(el.childNodes).map((node) => getTextFromNode(node)).join("");
}

export function getSerializedTextFromEditor(el: HTMLElement): string {
  return Array.from(el.childNodes).map((node) => getTextFromNode(node, { serializeMentions: true })).join("");
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

function inactiveSlashCommandState(): SlashCommandState {
  return { ...inactiveTriggerState(), trigger: "/" };
}

function detectTriggerInEditor(el: HTMLElement, trigger: "@" | "/" | "$"): TriggerState {
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
  const slashState = detectTriggerInEditor(el, "/");
  const dollarState = detectTriggerInEditor(el, "$");
  const activeStates = [
    slashState.active ? { ...slashState, trigger: "/" as const } : null,
    dollarState.active ? { ...dollarState, trigger: "$" as const } : null,
  ].filter((state): state is SlashCommandState => state !== null);

  if (activeStates.length === 0) {
    return inactiveSlashCommandState();
  }

  return activeStates.reduce((latest, state) => (
    state.startOffset > latest.startOffset ? state : latest
  ));
}

export const FILE_ICON_SVG =
  '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13H8"/><path d="M16 17H8"/><path d="M16 13h-2"/>';

export const FOLDER_ICON_SVG =
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>';

export const PAPERCLIP_ICON_SVG =
  '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>';
