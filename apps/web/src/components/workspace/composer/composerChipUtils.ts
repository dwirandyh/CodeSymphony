import type { PendingAttachment } from "../../../lib/attachments";
import { getAttachmentDisplayLabel } from "../../../lib/attachments";
import { fileName, FILE_ICON_SVG, FOLDER_ICON_SVG, PAPERCLIP_ICON_SVG } from "./composerEditorUtils";
import type { MentionedFile } from "./composerEditorUtils";

export function createChipElement(file: MentionedFile): HTMLSpanElement {
  const isDir = file.type === "directory";
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.mentionPath = file.path;
  chip.dataset.mentionId = file.id;
  chip.dataset.mentionType = file.type;
  chip.className = isDir
    ? "inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/15 px-1.5 py-0 text-xs text-amber-400 mx-0.5 align-baseline cursor-default select-none"
    : "inline-flex items-center gap-1 rounded-md border border-blue-500/30 bg-blue-500/15 px-1.5 py-0 text-xs text-blue-400 mx-0.5 align-baseline cursor-default select-none";
  chip.setAttribute("title", file.path);

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("class", "h-3 w-3 shrink-0 inline-block");
  icon.innerHTML = isDir ? FOLDER_ICON_SVG : FILE_ICON_SVG;

  const label = document.createElement("span");
  label.className = "max-w-[140px] truncate";
  label.textContent = fileName(file.path);

  chip.appendChild(icon);
  chip.appendChild(label);

  return chip;
}

export function createAttachmentChipElement(attachment: PendingAttachment): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.attachmentId = attachment.id;
  chip.className =
    "inline-flex items-center gap-1 rounded-md border border-purple-500/30 bg-purple-500/15 px-1.5 py-0 text-xs text-purple-400 mx-0.5 align-baseline cursor-pointer select-none hover:bg-purple-500/25";
  chip.setAttribute("title", attachment.filename);
  chip.setAttribute("role", "button");
  chip.setAttribute("tabindex", "-1");

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("class", "h-3 w-3 shrink-0 inline-block");
  icon.innerHTML = PAPERCLIP_ICON_SVG;

  const label = document.createElement("span");
  label.className = "max-w-[140px] truncate";
  label.textContent = getAttachmentDisplayLabel(attachment);

  chip.appendChild(icon);
  chip.appendChild(label);

  return chip;
}
