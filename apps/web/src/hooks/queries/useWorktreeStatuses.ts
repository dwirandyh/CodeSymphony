import { useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import type { ChatThread, ChatThreadSnapshot, Repository } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { aggregateWorktreeStatus, type WorktreeStatusSummary } from "../../pages/workspace/hooks/worktreeThreadStatus";

export function useWorktreeStatuses(repositories: Repository[]) {
  const activeWorktreeIds = useMemo(
    () => repositories.flatMap((repository) => repository.worktrees.filter((worktree) => worktree.status === "active").map((worktree) => worktree.id)),
    [repositories],
  );

  const threadListResult = useQueries({
    queries: activeWorktreeIds.map((worktreeId) => ({
      queryKey: queryKeys.threads.list(worktreeId),
      queryFn: () => api.listThreads(worktreeId),
      enabled: worktreeId.length > 0,
      staleTime: 5_000,
    })),
    combine: (results) => {
      const threadsByWorktreeId: Record<string, ChatThread[]> = {};
      const allThreadIds: string[] = [];
      for (let i = 0; i < activeWorktreeIds.length; i++) {
        const threads = results[i]?.data ?? [];
        threadsByWorktreeId[activeWorktreeIds[i]] = threads;
        for (const thread of threads) {
          allThreadIds.push(thread.id);
        }
      }
      return { threadsByWorktreeId, threadIds: allThreadIds };
    },
  });

  const { threadsByWorktreeId, threadIds } = threadListResult;

  const prevThreadIdsRef = useRef<string[]>([]);
  const stableThreadIds = useMemo(() => {
    const prev = prevThreadIdsRef.current;
    if (prev.length === threadIds.length && prev.every((id, i) => id === threadIds[i])) {
      return prev;
    }
    prevThreadIdsRef.current = threadIds;
    return threadIds;
  }, [threadIds]);

  const snapshotResult = useQueries({
    queries: stableThreadIds.map((threadId) => ({
      queryKey: queryKeys.threads.statusSnapshot(threadId),
      queryFn: () => api.getThreadSnapshot(threadId),
      enabled: threadId.length > 0,
      staleTime: 15_000,
    })),
    combine: (results) => {
      const snapshotsByThreadId: Record<string, ChatThreadSnapshot | null> = {};
      for (let i = 0; i < stableThreadIds.length; i++) {
        snapshotsByThreadId[stableThreadIds[i]] = (results[i]?.data ?? null) as ChatThreadSnapshot | null;
      }
      return snapshotsByThreadId;
    },
  });

  return useMemo<Record<string, WorktreeStatusSummary>>(() => {
    const entries = activeWorktreeIds.map((worktreeId) => {
      const threads = threadsByWorktreeId[worktreeId] ?? [];
      const summary = aggregateWorktreeStatus(
        threads.map((thread) => ({
          thread,
          snapshot: snapshotResult[thread.id] ?? null,
        })),
      );

      return [worktreeId, summary] as const;
    });

    return Object.fromEntries(entries);
  }, [activeWorktreeIds, snapshotResult, threadsByWorktreeId]);
}
