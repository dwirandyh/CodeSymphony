import { useMemo, useRef } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type { ChatThread, ChatThreadStatusSnapshot, Repository } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import {
  aggregateWorktreeStatus,
  type WorktreeStatusSummary,
  type WorktreeThreadUiStatus,
} from "../../pages/workspace/hooks/worktreeThreadStatus";
import { buildRepositoryWorktreeIndex } from "../../collections/worktrees";
import { useThreadsByWorktreeIds, type ThreadsByWorktreeSnapshot } from "./useThreads";
import { pickStatusSnapshotCandidateIds } from "./worktreeStatusSnapshotCandidates";

export function useWorktreeStatuses(
  repositories: Repository[],
  enabled = true,
  threadSnapshot?: ThreadsByWorktreeSnapshot,
) {
  const queryClient = useQueryClient();
  const activeWorktreeIds = useMemo(
    () => buildRepositoryWorktreeIndex(repositories).activeWorktreeIds,
    [repositories],
  );
  const ownedThreadSnapshot = useThreadsByWorktreeIds(activeWorktreeIds, {
    enabled: enabled && threadSnapshot == null,
  });
  const { threadsByWorktreeId, threadIds } = threadSnapshot ?? ownedThreadSnapshot;

  const prevThreadIdsRef = useRef<string[]>([]);
  const stableThreadIds = useMemo(() => {
    const prev = prevThreadIdsRef.current;
    if (prev.length === threadIds.length && prev.every((id, i) => id === threadIds[i])) {
      return prev;
    }
    prevThreadIdsRef.current = threadIds;
    return threadIds;
  }, [threadIds]);

  const statusSnapshotCandidateIds = useMemo(() => {
    const snapshotsByThreadId: Record<string, ChatThreadStatusSnapshot | null> = {};
    for (const threads of Object.values(threadsByWorktreeId)) {
      for (const thread of threads) {
        snapshotsByThreadId[thread.id] = queryClient.getQueryData<ChatThreadStatusSnapshot>(
          queryKeys.threads.statusSnapshot(thread.id),
        ) ?? null;
      }
    }
    return pickStatusSnapshotCandidateIds(threadsByWorktreeId, snapshotsByThreadId);
  }, [queryClient, threadsByWorktreeId]);

  const prevStatusSnapshotCandidateIdsRef = useRef<string[]>([]);
  const stableStatusSnapshotCandidateIds = useMemo(() => {
    const prev = prevStatusSnapshotCandidateIdsRef.current;
    if (
      prev.length === statusSnapshotCandidateIds.length
      && prev.every((id, index) => id === statusSnapshotCandidateIds[index])
    ) {
      return prev;
    }

    prevStatusSnapshotCandidateIdsRef.current = statusSnapshotCandidateIds;
    return statusSnapshotCandidateIds;
  }, [statusSnapshotCandidateIds]);

  const snapshotResult = useQueries({
    queries: stableStatusSnapshotCandidateIds.map((threadId) => ({
      queryKey: queryKeys.threads.statusSnapshot(threadId),
      queryFn: () => api.getThreadStatusSnapshot(threadId),
      enabled: enabled && threadId.length > 0,
      staleTime: 15_000,
    })),
    combine: (results) => {
      const snapshotsByThreadId: Record<string, ChatThreadStatusSnapshot | null> = {};
      for (let i = 0; i < stableStatusSnapshotCandidateIds.length; i++) {
        snapshotsByThreadId[stableStatusSnapshotCandidateIds[i]] = (results[i]?.data ?? null) as ChatThreadStatusSnapshot | null;
      }
      for (const threadId of stableThreadIds) {
        if (!(threadId in snapshotsByThreadId)) {
          snapshotsByThreadId[threadId] = null;
        }
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
