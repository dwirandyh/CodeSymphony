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
import { useThreadsByWorktreeIds, type ThreadsByWorktreeSnapshot } from "./useThreads";

// Repository sidebar only needs a small set of candidate threads per worktree
// to render a useful status chip. Fetching every historical thread snapshot
// creates a large request fan-out on refresh.
const MAX_INACTIVE_STATUS_SNAPSHOTS_PER_WORKTREE = 2;

function compareThreadRecency(left: ChatThread, right: ChatThread) {
  return (
    right.updatedAt.localeCompare(left.updatedAt)
    || right.createdAt.localeCompare(left.createdAt)
    || right.id.localeCompare(left.id)
  );
}

function pickStatusSnapshotCandidateIds(threadsByWorktreeId: Record<string, ChatThread[]>): string[] {
  const candidateIds: string[] = [];

  for (const threads of Object.values(threadsByWorktreeId)) {
    const activeThreadIds = threads
      .filter((thread) => thread.active)
      .map((thread) => thread.id);
    const inactiveThreadIds = threads
      .filter((thread) => !thread.active)
      .sort(compareThreadRecency)
      .slice(0, MAX_INACTIVE_STATUS_SNAPSHOTS_PER_WORKTREE)
      .map((thread) => thread.id);

    candidateIds.push(...activeThreadIds, ...inactiveThreadIds);
  }

  return [...new Set(candidateIds)];
}

export function useWorktreeStatuses(
  repositories: Repository[],
  enabled = true,
  threadSnapshot?: ThreadsByWorktreeSnapshot,
) {
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

  const statusSnapshotCandidateIds = useMemo(
    () => pickStatusSnapshotCandidateIds(threadsByWorktreeId),
    [threadsByWorktreeId],
  );

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
