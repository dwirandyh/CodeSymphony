import type { ChatThread, ChatThreadStatusSnapshot } from "@codesymphony/shared-types";
import { isOptimisticThreadId } from "../../lib/threadIds";

// Keep fan-out bounded for idle history, but never drop threads that still need user action.
export const MAX_INACTIVE_STATUS_SNAPSHOTS_PER_WORKTREE = 2;

const GATE_STATUS_SNAPSHOTS = new Set<ChatThreadStatusSnapshot["status"]>([
  "waiting_approval",
  "review_plan",
]);

function compareThreadRecency(left: ChatThread, right: ChatThread) {
  return (
    right.updatedAt.localeCompare(left.updatedAt)
    || right.createdAt.localeCompare(left.createdAt)
    || right.id.localeCompare(left.id)
  );
}

function isGateStatusSnapshot(status: ChatThreadStatusSnapshot["status"] | null | undefined): boolean {
  return status != null && GATE_STATUS_SNAPSHOTS.has(status);
}

export function pickStatusSnapshotCandidateIds(
  threadsByWorktreeId: Record<string, ChatThread[]>,
  snapshotsByThreadId: Record<string, ChatThreadStatusSnapshot | null | undefined> = {},
): string[] {
  const candidateIds: string[] = [];

  for (const threads of Object.values(threadsByWorktreeId)) {
    const activeThreadIds = threads
      .filter((thread) => thread.active && !isOptimisticThreadId(thread.id))
      .map((thread) => thread.id);

    const inactiveThreads = threads
      .filter((thread) => !thread.active && !isOptimisticThreadId(thread.id))
      .sort(compareThreadRecency);

    const recentInactiveThreadIds = inactiveThreads
      .slice(0, MAX_INACTIVE_STATUS_SNAPSHOTS_PER_WORKTREE)
      .map((thread) => thread.id);

    const gatedInactiveThreadIds = inactiveThreads
      .filter((thread) => isGateStatusSnapshot(snapshotsByThreadId[thread.id]?.status))
      .map((thread) => thread.id);

    candidateIds.push(...activeThreadIds, ...recentInactiveThreadIds, ...gatedInactiveThreadIds);
  }

  return [...new Set(candidateIds)];
}
