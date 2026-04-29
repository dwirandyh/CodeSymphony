import { createThreadEventsCollection, type ThreadEventsCollection } from "./threadEvents";
import { createThreadMessagesCollection, type ThreadMessagesCollection } from "./threadMessages";

export type { ThreadEventsCollection, ThreadMessagesCollection };

const DEFAULT_MAX_RETAINED_THREADS = 3;

type RegisteredThreadCollections = {
  threadId: string;
  eventsCollection: ThreadEventsCollection;
  messagesCollection: ThreadMessagesCollection;
  lastAccessedAt: number;
};

const threadCollectionsRegistry = new Map<string, RegisteredThreadCollections>();

function now() {
  return Date.now();
}

function touchThreadCollections(entry: RegisteredThreadCollections) {
  entry.lastAccessedAt = now();
  return entry;
}

function createRegisteredThreadCollections(threadId: string): RegisteredThreadCollections {
  return {
    threadId,
    eventsCollection: createThreadEventsCollection(threadId),
    messagesCollection: createThreadMessagesCollection(threadId),
    lastAccessedAt: now(),
  };
}

function cleanupRegisteredThreadCollections(entry: RegisteredThreadCollections) {
  void entry.eventsCollection.cleanup();
  void entry.messagesCollection.cleanup();
}

export function getThreadCollections(threadId: string): RegisteredThreadCollections {
  const existing = threadCollectionsRegistry.get(threadId);
  if (existing) {
    return touchThreadCollections(existing);
  }

  const created = createRegisteredThreadCollections(threadId);
  threadCollectionsRegistry.set(threadId, created);
  return created;
}

export function getThreadEventsCollection(threadId: string) {
  return getThreadCollections(threadId).eventsCollection;
}

export function getThreadMessagesCollection(threadId: string) {
  return getThreadCollections(threadId).messagesCollection;
}

export function getThreadCollectionCounts(threadId: string) {
  const existing = threadCollectionsRegistry.get(threadId);
  if (!existing) {
    return null;
  }

  return {
    messagesCount: existing.messagesCollection.toArray.length,
    eventsCount: existing.eventsCollection.toArray.length,
  };
}

export function disposeThreadCollections(threadId: string) {
  const existing = threadCollectionsRegistry.get(threadId);
  if (!existing) {
    return;
  }

  threadCollectionsRegistry.delete(threadId);
  cleanupRegisteredThreadCollections(existing);
}

export function pruneThreadCollections(options?: {
  activeThreadId?: string | null;
  retainThreadIds?: Iterable<string>;
  maxRetained?: number;
}) {
  const activeThreadId = options?.activeThreadId ?? null;
  const retainThreadIds = new Set(options?.retainThreadIds ?? []);
  if (activeThreadId) {
    retainThreadIds.add(activeThreadId);
  }

  const maxRetained = options?.maxRetained ?? DEFAULT_MAX_RETAINED_THREADS;
  const candidates = [...threadCollectionsRegistry.values()]
    .filter((entry) => !retainThreadIds.has(entry.threadId))
    .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);

  const retainedRecent = new Set(
    candidates.slice(0, Math.max(0, maxRetained - retainThreadIds.size)).map((entry) => entry.threadId),
  );

  for (const entry of candidates) {
    if (retainedRecent.has(entry.threadId)) {
      continue;
    }
    disposeThreadCollections(entry.threadId);
  }
}

export function disposeAllThreadCollections() {
  for (const threadId of [...threadCollectionsRegistry.keys()]) {
    disposeThreadCollections(threadId);
  }
}

export function resetThreadCollectionsForTest() {
  disposeAllThreadCollections();
}
