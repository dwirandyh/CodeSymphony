import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";

/**
 * Strips a live-collection row down to a plain {@link ChatMessage}. The live
 * query rows carry proxy/identity wrappers; persisting a plain object keeps
 * downstream memoization comparisons stable.
 */
export function toPlainChatMessage(message: ChatMessage): ChatMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    seq: message.seq,
    role: message.role,
    content: message.content,
    attachments: message.attachments,
    createdAt: message.createdAt,
  };
}

/** Plain-object projection of a live {@link ChatEvent} row. */
export function toPlainChatEvent(event: ChatEvent): ChatEvent {
  return {
    id: event.id,
    threadId: event.threadId,
    idx: event.idx,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

/**
 * Returns the same array reference when already sorted, otherwise a sorted
 * clone. Bailing out on the common (already sorted) path avoids needless
 * re-renders downstream.
 */
export function cloneSortedIfNeeded<T>(rows: T[], compare: (left: T, right: T) => number): T[] {
  for (let index = 1; index < rows.length; index += 1) {
    if (compare(rows[index - 1], rows[index]) > 0) {
      return [...rows].sort(compare);
    }
  }

  return rows;
}
