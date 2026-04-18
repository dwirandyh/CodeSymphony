export type CollectionOwnership = "query" | "local-only";

export const COLLECTION_OWNERSHIP_RULES = {
  query: {
    owner: "server",
    writeRule: "Never write SSE deltas into a QueryCollection.",
    examples: [
      "repositoriesCollection",
      "threadsCollection(worktreeId)",
      "gitStatusCollection(worktreeId)",
    ],
  },
  "local-only": {
    owner: "client-stream",
    writeRule: "Active-thread events/messages are hydrated from snapshots and patched from SSE.",
    examples: [
      "threadEventsCollection(threadId)",
      "threadMessagesCollection(threadId)",
    ],
  },
} as const satisfies Record<
  CollectionOwnership,
  {
    owner: string;
    writeRule: string;
    examples: string[];
  }
>;
