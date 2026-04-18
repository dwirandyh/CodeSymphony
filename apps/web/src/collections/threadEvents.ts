import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import type { ChatEvent } from "@codesymphony/shared-types";

export function createThreadEventsCollection(threadId: string) {
  return createCollection(
    localOnlyCollectionOptions<ChatEvent, string>({
      id: `thread-events:${threadId}`,
      getKey: (event) => event.id,
      compare: (left, right) => left.idx - right.idx,
      initialData: [],
    }),
  );
}

export type ThreadEventsCollection = ReturnType<typeof createThreadEventsCollection>;
