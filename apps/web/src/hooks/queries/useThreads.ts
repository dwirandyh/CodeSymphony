import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import type { ChatThread } from "@codesymphony/shared-types";
import { getThreadsCollection, toPlainChatThread } from "../../collections/threads";

export type ThreadsByWorktreeSnapshot = {
  threadsByWorktreeId: Record<string, ChatThread[]>;
  threadIds: string[];
  isLoading: boolean;
};

const EMPTY_THREADS_BY_WORKTREE_SNAPSHOT: ThreadsByWorktreeSnapshot = {
  threadsByWorktreeId: {},
  threadIds: [],
  isLoading: false,
};

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

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
): ThreadsByWorktreeSnapshot {
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

export function useThreadsByWorktreeIds(
  worktreeIds: string[],
  options?: {
    enabled?: boolean;
  },
) {
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const [stableWorktreeIds, setStableWorktreeIds] = useState(worktreeIds);

  useEffect(() => {
    setStableWorktreeIds((current) => sameIds(current, worktreeIds) ? current : worktreeIds);
  }, [worktreeIds]);

  const collections = useMemo(
    () => enabled
      ? stableWorktreeIds.map((worktreeId) => ({ worktreeId, collection: getThreadsCollection(queryClient, worktreeId) }))
      : [],
    [enabled, queryClient, stableWorktreeIds],
  );
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled || collections.length === 0) {
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
  }, [collections, enabled]);

  return useMemo(
    () => enabled ? buildThreadsByWorktreeSnapshot(collections) : EMPTY_THREADS_BY_WORKTREE_SNAPSHOT,
    [collections, enabled, version],
  );
}
