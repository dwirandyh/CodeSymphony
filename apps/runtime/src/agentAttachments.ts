import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ChatAgentAttachment } from "./types.js";

export function isImageAttachment(attachment: ChatAgentAttachment): boolean {
  return attachment.mimeType.startsWith("image/");
}

export async function readAttachmentBase64(attachment: ChatAgentAttachment): Promise<string | null> {
  const inlineContent = attachment.content.trim();
  if (inlineContent.length > 0) {
    return inlineContent;
  }

  if (!attachment.storagePath) {
    return null;
  }

  const buffer = await readFile(attachment.storagePath);
  return buffer.toString("base64");
}

export async function buildAttachmentDataUrl(attachment: ChatAgentAttachment): Promise<string | null> {
  const base64 = await readAttachmentBase64(attachment);
  if (!base64) {
    return null;
  }

  return `data:${attachment.mimeType};base64,${base64}`;
}

export function buildAttachmentFileUrl(attachment: ChatAgentAttachment): string | null {
  if (!attachment.storagePath) {
    return null;
  }

  return pathToFileURL(attachment.storagePath).toString();
}
