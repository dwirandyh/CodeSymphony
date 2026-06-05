import type { WorktreeStatusSummary } from "./hooks/worktreeThreadStatus";
import type { ChatThreadStatusSnapshot } from "@codesymphony/shared-types";

function hasMatchingWorktreeStatusSummary(
  left: WorktreeStatusSummary | null | undefined,
  right: WorktreeStatusSummary | null | undefined,
) {
  return left?.kind === right?.kind && left?.threadId === right?.threadId;
}

export function reconcileWorktreeStatusOverrides(params: {
  current: Record<string, WorktreeStatusSummary>;
  selectedWorktreeId: string | null;
  selectedWorktreeStatusOverride: WorktreeStatusSummary | null;
  activeThreadIdsByWorktreeId: Record<string, Set<string>>;
}): Record<string, WorktreeStatusSummary> {
  const { current, selectedWorktreeId, selectedWorktreeStatusOverride, activeThreadIdsByWorktreeId } = params;

  if (!selectedWorktreeId) {
    return current;
  }

  if (!selectedWorktreeStatusOverride) {
    const existing = current[selectedWorktreeId];
    const activeThreadIds = activeThreadIdsByWorktreeId[selectedWorktreeId];
    if (existing?.threadId && activeThreadIds?.has(existing.threadId)) {
      return current;
    }

    if (!(selectedWorktreeId in current)) {
      return current;
    }

    const next = { ...current };
    delete next[selectedWorktreeId];
    return next;
  }

  const existing = current[selectedWorktreeId];
  if (hasMatchingWorktreeStatusSummary(existing, selectedWorktreeStatusOverride)) {
    return current;
  }

  return {
    ...current,
    [selectedWorktreeId]: selectedWorktreeStatusOverride,
  };
}

export function pruneSettledWorktreeStatusOverrides(params: {
  current: Record<string, WorktreeStatusSummary>;
  selectedWorktreeId: string | null;
  statusSnapshotsByThreadId: Record<string, ChatThreadStatusSnapshot | null>;
  activeThreadIds: Set<string>;
  selectedWorktreeStatusOverride: WorktreeStatusSummary | null;
}): Record<string, WorktreeStatusSummary> {
  const {
    current,
    selectedWorktreeId,
    statusSnapshotsByThreadId,
    activeThreadIds,
    selectedWorktreeStatusOverride,
  } = params;
  let next: Record<string, WorktreeStatusSummary> | null = null;

  for (const [worktreeId, override] of Object.entries(current)) {
    if (
      worktreeId === selectedWorktreeId
      && selectedWorktreeStatusOverride?.threadId === override.threadId
    ) {
      continue;
    }

    if (!override.threadId) {
      continue;
    }

    if (activeThreadIds.has(override.threadId)) {
      continue;
    }

    const snapshot = statusSnapshotsByThreadId[override.threadId];
    if (!snapshot || snapshot.status === override.kind) {
      continue;
    }

    next ??= { ...current };
    delete next[worktreeId];
  }

  return next ?? current;
}
