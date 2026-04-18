import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import type { ChatMessage } from "@codesymphony/shared-types";

export function createThreadMessagesCollection(threadId: string) {
  return createCollection(
    localOnlyCollectionOptions<ChatMessage, string>({
      id: `thread-messages:${threadId}`,
      getKey: (message) => message.id,
      compare: (left, right) => left.seq - right.seq,
      initialData: [],
    }),
  );
}

export type ThreadMessagesCollection = ReturnType<typeof createThreadMessagesCollection>;
