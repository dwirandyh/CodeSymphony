import { createCollection } from "@tanstack/db";
import type { ChatThread } from "@codesymphony/shared-types";
import type { QueryClient } from "@tanstack/react-query";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { api } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";

function compareThreads(left: ChatThread, right: ChatThread) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function toPlainChatThread(thread: ChatThread): ChatThread {
  return {
    id: thread.id,
    worktreeId: thread.worktreeId,
    title: thread.title,
    kind: thread.kind,
    permissionProfile: thread.permissionProfile,
    permissionMode: thread.permissionMode,
    mode: thread.mode,
    titleEditedManually: thread.titleEditedManually,
    claudeSessionId: thread.claudeSessionId,
    active: thread.active,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function createThreadsCollection(queryClient: QueryClient, worktreeId: string) {
  return createCollection(
    queryCollectionOptions<ChatThread>({
      id: `threads:${worktreeId}`,
      queryKey: queryKeys.threads.list(worktreeId),
      queryFn: () => api.listThreads(worktreeId),
      queryClient,
      getKey: (thread) => thread.id,
      compare: compareThreads,
      staleTime: 5_000,
    }),
  );
}

type ThreadsCollection = ReturnType<typeof createThreadsCollection>;

const threadsCollectionRegistry = new Map<QueryClient, Map<string, ThreadsCollection>>();

function getThreadCollectionsRegistry(queryClient: QueryClient) {
  let existing = threadsCollectionRegistry.get(queryClient);
  if (existing) {
    return existing;
  }

  existing = new Map<string, ThreadsCollection>();
  threadsCollectionRegistry.set(queryClient, existing);
  return existing;
}

export function getThreadsCollection(queryClient: QueryClient, worktreeId: string): ThreadsCollection {
  const registry = getThreadCollectionsRegistry(queryClient);
  const existing = registry.get(worktreeId);
  if (existing) {
    return existing;
  }

  const created = createThreadsCollection(queryClient, worktreeId);
  registry.set(worktreeId, created);
  return created;
}

export function refetchThreadsCollection(queryClient: QueryClient, worktreeId: string) {
  return getThreadsCollection(queryClient, worktreeId).utils.refetch();
}

export function removeThreadFromCollection(queryClient: QueryClient, worktreeId: string, threadId: string) {
  const collection = getThreadsCollection(queryClient, worktreeId);
  if (!(collection.toArray as ChatThread[]).some((thread) => thread.id === threadId)) {
    return;
  }
  collection.utils.writeDelete(threadId);
}

export function patchThreadInCollection(
  queryClient: QueryClient,
  worktreeId: string,
  threadId: string,
  patch: Partial<ChatThread>,
) {
  const collection = getThreadsCollection(queryClient, worktreeId);
  if (!(collection.toArray as ChatThread[]).some((thread) => thread.id === threadId)) {
    return;
  }

  collection.utils.writeUpdate({
    id: threadId,
    ...patch,
  });
}

export function upsertThreadInCollection(queryClient: QueryClient, worktreeId: string, thread: Partial<ChatThread> & { id: string }) {
  getThreadsCollection(queryClient, worktreeId).utils.writeUpsert(thread);
}

export function resetThreadsCollectionRegistryForTest() {
  for (const collections of threadsCollectionRegistry.values()) {
    for (const collection of collections.values()) {
      void collection.cleanup();
    }
    collections.clear();
  }
  threadsCollectionRegistry.clear();
}
