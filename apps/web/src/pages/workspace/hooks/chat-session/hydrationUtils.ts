import type { ChatTimelineSnapshot } from "@codesymphony/shared-types";
import type { SnapshotSeedDecision } from "./useChatSession.types";

export function shouldInvalidateSnapshotImmediatelyAfterSubmit(): boolean {
  return false;
}

export function buildSnapshotKey(snapshot: ChatTimelineSnapshot): string {
  return [
    snapshot.newestSeq ?? "null",
    snapshot.newestIdx ?? "null",
    snapshot.messages.length,
    snapshot.events.length,
    snapshot.timelineItems.length,
  ].join(":");
}

export function resolveSnapshotSeedDecision(params: {
  selectedThreadId: string | null;
  queriedThreadSnapshot: ChatTimelineSnapshot | undefined;
  threadChanged: boolean;
  lastAppliedSnapshotKey: string | null;
  localLatestEventIdx?: number | null;
  hasPendingUserGate?: boolean;
}): SnapshotSeedDecision {
  const {
    selectedThreadId,
    queriedThreadSnapshot,
    threadChanged,
    lastAppliedSnapshotKey,
    localLatestEventIdx = null,
    hasPendingUserGate = false,
  } = params;
  if (!selectedThreadId || !queriedThreadSnapshot) {
    return { shouldApply: false, reason: "no-thread-or-snapshot", snapshotKey: null };
  }

  const snapshotKey = buildSnapshotKey(queriedThreadSnapshot);
  if (threadChanged) {
    return { shouldApply: true, reason: "thread-changed", snapshotKey };
  }

  const snapshotNewestIdx = queriedThreadSnapshot.newestIdx ?? null;
  if (
    localLatestEventIdx != null
    && snapshotNewestIdx != null
    && localLatestEventIdx > snapshotNewestIdx
  ) {
    return { shouldApply: false, reason: "local-state-ahead", snapshotKey };
  }

  if (hasPendingUserGate) {
    return { shouldApply: false, reason: "pending-user-gate", snapshotKey };
  }

  if (lastAppliedSnapshotKey === snapshotKey) {
    return { shouldApply: false, reason: "same-snapshot-key", snapshotKey };
  }

  return { shouldApply: true, reason: "snapshot-key-changed", snapshotKey };
}
