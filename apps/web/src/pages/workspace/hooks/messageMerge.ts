import type { ChatAttachment, ChatMessage } from "@codesymphony/shared-types";

function areAttachmentsEqual(a: ChatAttachment[] | undefined, b: ChatAttachment[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];

  if (left.length !== right.length) {
    return false;
  }

  for (let i = 0; i < left.length; i += 1) {
    const lhs = left[i];
    const rhs = right[i];
    if (
      lhs.id !== rhs.id ||
      lhs.messageId !== rhs.messageId ||
      lhs.filename !== rhs.filename ||
      lhs.mimeType !== rhs.mimeType ||
      lhs.sizeBytes !== rhs.sizeBytes ||
      lhs.source !== rhs.source ||
      lhs.storagePath !== rhs.storagePath ||
      lhs.content.length !== rhs.content.length ||
      lhs.content !== rhs.content
    ) {
      return false;
    }
  }

  return true;
}

export function areMessagesEqual(a: ChatMessage, b: ChatMessage): boolean {
  if (
    a.id !== b.id ||
    a.threadId !== b.threadId ||
    a.seq !== b.seq ||
    a.role !== b.role ||
    a.content !== b.content ||
    a.createdAt !== b.createdAt
  ) {
    return false;
  }

  return areAttachmentsEqual(a.attachments, b.attachments);
}

export function areMessageArraysEqual(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (!areMessagesEqual(a[i], b[i])) {
      return false;
    }
  }

  return true;
}

function shouldPreferLocalMessage(queried: ChatMessage, local: ChatMessage): boolean {
  return local.content.length > queried.content.length;
}

export function mergeThreadMessages(queriedMessages: ChatMessage[], localMessages: ChatMessage[]): ChatMessage[] {
  const merged = new Map<string, ChatMessage>();
  for (const message of queriedMessages) {
    merged.set(message.id, message);
  }

  for (const local of localMessages) {
    const queried = merged.get(local.id);
    if (!queried) {
      merged.set(local.id, local);
      continue;
    }

    if (shouldPreferLocalMessage(queried, local)) {
      merged.set(local.id, local);
    }
  }

  return [...merged.values()].sort((a, b) => a.seq - b.seq);
}
