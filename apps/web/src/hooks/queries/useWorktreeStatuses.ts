import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { ChatThreadSnapshot, Repository } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { INITIAL_EVENTS_PAGE_LIMIT, INITIAL_MESSAGES_PAGE_LIMIT } from "../../pages/workspace/constants";
import { aggregateWorktreeStatus, type WorktreeStatusSummary } from "../../pages/workspace/hooks/worktreeThreadStatus";

export function useWorktreeStatuses(repositories: Repository[]) {
  const activeWorktreeIds = useMemo(
    () => repositories.flatMap((repository) => repository.worktrees.filter((worktree) => worktree.status === "active").map((worktree) => worktree.id)),
    [repositories],
  );

  const threadListQueries = useQueries({
    queries: activeWorktreeIds.map((worktreeId) => ({
      queryKey: queryKeys.threads.list(worktreeId),
      queryFn: () => api.listThreads(worktreeId),
      enabled: worktreeId.length > 0,
      staleTime: 5_000,
    })),
  });

  const threadsByWorktreeId = useMemo(
    () => Object.fromEntries(activeWorktreeIds.map((worktreeId, index) => [worktreeId, threadListQueries[index]?.data ?? []])),
    [activeWorktreeIds, threadListQueries],
  );

  const threadIds = useMemo(
    () => activeWorktreeIds.flatMap((worktreeId) => (threadsByWorktreeId[worktreeId] ?? []).map((thread) => thread.id)),
    [activeWorktreeIds, threadsByWorktreeId],
  );

  const snapshotQueries = useQueries({
    queries: threadIds.map((threadId) => ({
      queryKey: queryKeys.threads.snapshot(threadId),
      queryFn: () => api.getThreadSnapshot(threadId, {
        messageLimit: INITIAL_MESSAGES_PAGE_LIMIT,
        eventLimit: INITIAL_EVENTS_PAGE_LIMIT,
      }),
      enabled: threadId.length > 0,
      staleTime: 5_000,
    })),
  });

  const snapshotsByThreadId = useMemo(
    () => Object.fromEntries(threadIds.map((threadId, index) => [threadId, (snapshotQueries[index]?.data ?? null) as ChatThreadSnapshot | null])),
    [threadIds, snapshotQueries],
  );

  return useMemo<Record<string, WorktreeStatusSummary>>(() => {
    const entries = activeWorktreeIds.map((worktreeId) => {
      const threads = threadsByWorktreeId[worktreeId] ?? [];
      const summary = aggregateWorktreeStatus(
        threads.map((thread) => ({
          thread,
          snapshot: snapshotsByThreadId[thread.id] ?? null,
        })),
      );

      return [worktreeId, summary] as const;
    });

    return Object.fromEntries(entries);
  }, [activeWorktreeIds, snapshotsByThreadId, threadsByWorktreeId]);
}
