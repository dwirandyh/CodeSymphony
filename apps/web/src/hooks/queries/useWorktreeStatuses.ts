import { useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import type { ChatThread, ChatThreadStatusSnapshot, Repository } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import {
  aggregateWorktreeStatus,
  type WorktreeStatusSummary,
  type WorktreeThreadUiStatus,
} from "../../pages/workspace/hooks/worktreeThreadStatus";
import { buildRepositoryWorktreeIndex } from "../../collections/worktrees";
import { useThreadsByWorktreeIds } from "./useThreads";

export function useWorktreeStatuses(repositories: Repository[], enabled = true) {
  const activeWorktreeIds = useMemo(
    () => buildRepositoryWorktreeIndex(repositories).activeWorktreeIds,
    [repositories],
  );
  const { threadsByWorktreeId, threadIds } = useThreadsByWorktreeIds(activeWorktreeIds);

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
      queryFn: () => api.getThreadStatusSnapshot(threadId),
      enabled: enabled && threadId.length > 0,
      staleTime: 15_000,
    })),
    combine: (results) => {
      const snapshotsByThreadId: Record<string, ChatThreadStatusSnapshot | null> = {};
      for (let i = 0; i < stableThreadIds.length; i++) {
        snapshotsByThreadId[stableThreadIds[i]] = (results[i]?.data ?? null) as ChatThreadStatusSnapshot | null;
      }
      return snapshotsByThreadId;
    },
  });

  return useMemo<Record<string, WorktreeStatusSummary>>(() => {
    const entries = activeWorktreeIds.map((worktreeId) => {
      const threads = (threadsByWorktreeId[worktreeId] ?? []) as ChatThread[];
      const summary = aggregateWorktreeStatus(
        threads.map((thread) => ({
          thread,
          status: (snapshotResult[thread.id]?.status ?? null) as WorktreeThreadUiStatus | null,
        })),
      );

      return [worktreeId, summary] as const;
    });

    return Object.fromEntries(entries);
  }, [activeWorktreeIds, snapshotResult, threadsByWorktreeId]);
}
