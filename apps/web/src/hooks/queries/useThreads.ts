import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import type { ChatThread } from "@codesymphony/shared-types";
import { getThreadsCollection, toPlainChatThread } from "../../collections/threads";

export function useThreads(worktreeId: string | null) {
  const queryClient = useQueryClient();
  const collection = useMemo(
    () => worktreeId ? getThreadsCollection(queryClient, worktreeId) : null,
    [queryClient, worktreeId],
  );
  const { data: liveThreads, isLoading } = useLiveQuery(() => collection ?? undefined, [collection]);
  const data = useMemo(
    () => liveThreads?.map((thread) => toPlainChatThread(thread as ChatThread)),
    [liveThreads],
  );

  return {
    data,
    isLoading: collection ? isLoading || collection.utils.isLoading : false,
    isFetching: collection?.utils.isFetching ?? false,
    error: collection?.utils.lastError ?? null,
    isError: collection?.utils.isError ?? false,
    refetch: () => collection ? collection.utils.refetch() : Promise.resolve([]),
  };
}

function buildThreadsByWorktreeSnapshot(
  entries: Array<{ worktreeId: string; collection: ReturnType<typeof getThreadsCollection> }>,
) {
  const threadsByWorktreeId: Record<string, ChatThread[]> = {};
  const threadIds: string[] = [];
  let isLoading = false;

  for (const { worktreeId, collection } of entries) {
    const threads = (collection.toArray as ChatThread[]).map((thread) => toPlainChatThread(thread));
    threadsByWorktreeId[worktreeId] = threads;
    isLoading = isLoading || collection.utils.isLoading;

    for (const thread of threads) {
      threadIds.push(thread.id);
    }
  }

  return {
    threadsByWorktreeId,
    threadIds,
    isLoading,
  };
}

export function useThreadsByWorktreeIds(worktreeIds: string[]) {
  const queryClient = useQueryClient();
  const collections = useMemo(
    () => worktreeIds.map((worktreeId) => ({ worktreeId, collection: getThreadsCollection(queryClient, worktreeId) })),
    [queryClient, worktreeIds],
  );
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (collections.length === 0) {
      return;
    }

    const notify = () => {
      setVersion((current) => current + 1);
    };
    const subscriptions = collections.map(({ collection }) =>
      collection.subscribeChanges(
        () => {
          notify();
        },
        {
          onStatusChange: () => {
            notify();
          },
        },
      ),
    );

    notify();

    return () => {
      subscriptions.forEach((subscription) => subscription.unsubscribe());
    };
  }, [collections]);

  return useMemo(
    () => buildThreadsByWorktreeSnapshot(collections),
    [collections, version],
  );
}
