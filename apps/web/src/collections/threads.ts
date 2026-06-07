import { createCollection } from "@tanstack/db";
import type { ChatThread, WorkspaceStartupBootstrapData } from "@codesymphony/shared-types";
import type { QueryClient } from "@tanstack/react-query";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { api } from "../lib/api";
import { resolveAgentDefaultModel } from "../lib/agentModelDefaults";
import { queryKeys } from "../lib/queryKeys";
import {
  readWorkspaceStartupBootstrapQueryData,
  waitForWorkspaceStartupBootstrap,
} from "../lib/workspaceStartupBootstrap";
import { withWorkspaceCollectionPersistence } from "../lib/workspacePersistence";

function compareThreads(left: ChatThread, right: ChatThread) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function didBootstrapResolveThreadsForWorktree(
  startupBootstrapData: WorkspaceStartupBootstrapData | null,
  worktreeId: string,
) {
  return startupBootstrapData?.selection.worktreeId === worktreeId
    && startupBootstrapData.threadsLoaded === true;
}

export function toPlainChatThread(thread: ChatThread): ChatThread {
  const agent = thread.agent ?? "claude";
  return {
    id: thread.id,
    worktreeId: thread.worktreeId,
    title: thread.title,
    kind: thread.kind,
    isAutomation: thread.isAutomation ?? false,
    permissionProfile: thread.permissionProfile,
    permissionMode: thread.permissionMode,
    mode: thread.mode,
    titleEditedManually: thread.titleEditedManually,
    tabOpen: thread.tabOpen ?? true,
    agent,
    model: thread.model ?? resolveAgentDefaultModel(agent),
    modelProviderId: thread.modelProviderId ?? null,
    claudeSessionId: thread.claudeSessionId,
    codexSessionId: thread.codexSessionId ?? null,
    cursorSessionId: thread.cursorSessionId ?? null,
    opencodeSessionId: thread.opencodeSessionId ?? null,
    active: thread.active,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function createThreadsCollection(queryClient: QueryClient, worktreeId: string) {
  let readCurrentRows = (): ChatThread[] => [];
  let seededFromLocalState = false;

  const collection = createCollection(
    withWorkspaceCollectionPersistence(
      queryCollectionOptions<ChatThread>({
        id: `threads:${worktreeId}`,
        queryKey: queryKeys.threads.list(worktreeId),
        queryFn: async () => {
          const startupBootstrapData = await waitForWorkspaceStartupBootstrap();

          if (!seededFromLocalState) {
            seededFromLocalState = true;

            const currentRows = readCurrentRows();
            if (currentRows.length > 0) {
              return currentRows;
            }

            const cachedRows = readWorkspaceStartupBootstrapQueryData<ChatThread[] | undefined>(
              queryClient,
              queryKeys.threads.list(worktreeId),
            );
            if (
              cachedRows !== undefined
              && (cachedRows.length > 0 || didBootstrapResolveThreadsForWorktree(startupBootstrapData, worktreeId))
            ) {
              return cachedRows;
            }
          }

          return await api.listThreads(worktreeId);
        },
        queryClient,
        getKey: (thread) => thread.id,
        compare: compareThreads,
        staleTime: 5_000,
      }),
      { schemaVersion: 1 },
    ),
  );

  readCurrentRows = () => ((collection.toArray as unknown as ChatThread[]).map((thread) => toPlainChatThread(thread)));

  return collection;
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

export function getExistingThreadsCollection(queryClient: QueryClient, worktreeId: string): ThreadsCollection | null {
  return threadsCollectionRegistry.get(queryClient)?.get(worktreeId) ?? null;
}

export function refetchThreadsCollection(queryClient: QueryClient, worktreeId: string) {
  return getThreadsCollection(queryClient, worktreeId).utils.refetch();
}

export function refetchAllThreadsCollections(queryClient: QueryClient) {
  const registry = getThreadCollectionsRegistry(queryClient);
  return Promise.allSettled(
    [...registry.values()].map((collection) => collection.utils.refetch()),
  );
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

export function replaceThreadsCollection(queryClient: QueryClient, worktreeId: string, nextThreads: ChatThread[]) {
  const collection = getThreadsCollection(queryClient, worktreeId);
  const nextIds = new Set(nextThreads.map((thread) => thread.id));
  const currentIds = (collection.toArray as ChatThread[]).map((thread) => thread.id);

  collection.utils.writeBatch(() => {
    for (const threadId of currentIds) {
      if (!nextIds.has(threadId)) {
        collection.utils.writeDelete(threadId);
      }
    }

    for (const thread of nextThreads) {
      collection.utils.writeUpsert(thread);
    }
  });

  queryClient.setQueryData(
    queryKeys.threads.list(worktreeId),
    nextThreads.map((thread) => toPlainChatThread(thread)),
  );
}

export async function resetThreadsCollectionRegistryForTest() {
  const cleanupTasks: Promise<unknown>[] = [];
  for (const collections of threadsCollectionRegistry.values()) {
    for (const collection of collections.values()) {
      cleanupTasks.push(Promise.resolve(collection.cleanup()));
    }
    collections.clear();
  }
  threadsCollectionRegistry.clear();
  await Promise.allSettled(cleanupTasks);
}
