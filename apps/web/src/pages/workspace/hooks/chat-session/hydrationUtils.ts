import type { ChatTimelineSnapshot } from "@codesymphony/shared-types";
import type { SnapshotSeedDecision } from "./useChatSession.types";
import { buildSnapshotKey as buildSnapshotStateKey } from "../timelineStateFingerprint";

export function shouldInvalidateSnapshotImmediatelyAfterSubmit(): boolean {
  return false;
}

export function buildSnapshotKey(snapshot: ChatTimelineSnapshot): string {
  return buildSnapshotStateKey(snapshot);
}

export function resolveSnapshotSeedDecision(params: {
  selectedThreadId: string | null;
  queriedThreadSnapshot: ChatTimelineSnapshot | undefined;
  threadChanged: boolean;
  lastAppliedSnapshotKey: string | null;
  localLatestEventIdx?: number | null;
  localLatestMessageSeq?: number | null;
  sendingMessage?: boolean;
  waitingForAssistant?: boolean;
  hasPendingUserGate?: boolean;
}): SnapshotSeedDecision {
  const {
    selectedThreadId,
    queriedThreadSnapshot,
    threadChanged,
    lastAppliedSnapshotKey,
    localLatestEventIdx = null,
    localLatestMessageSeq = null,
    sendingMessage = false,
    waitingForAssistant = false,
    hasPendingUserGate = false,
  } = params;
  if (!selectedThreadId || !queriedThreadSnapshot) {
    return { shouldApply: false, reason: "no-thread-or-snapshot", snapshotKey: null };
  }

  const snapshotKey = buildSnapshotKey(queriedThreadSnapshot);
  const snapshotNewestIdx = queriedThreadSnapshot.newestIdx ?? null;
  if (
    localLatestEventIdx != null
    && snapshotNewestIdx != null
    && localLatestEventIdx > snapshotNewestIdx
  ) {
    return { shouldApply: false, reason: "local-state-ahead", snapshotKey };
  }

  const snapshotNewestSeq = queriedThreadSnapshot.newestSeq ?? null;
  if (
    sendingMessage
    && localLatestMessageSeq != null
    && (snapshotNewestSeq == null || localLatestMessageSeq > snapshotNewestSeq)
  ) {
    return { shouldApply: false, reason: "local-message-ahead-while-sending", snapshotKey };
  }

  if (
    waitingForAssistant
    && localLatestMessageSeq != null
    && (snapshotNewestSeq == null || localLatestMessageSeq > snapshotNewestSeq)
  ) {
    return { shouldApply: false, reason: "local-message-ahead-while-waiting", snapshotKey };
  }

  if (threadChanged) {
    return { shouldApply: true, reason: "thread-changed", snapshotKey };
  }

  if (hasPendingUserGate) {
    return { shouldApply: false, reason: "pending-user-gate", snapshotKey };
  }

  if (lastAppliedSnapshotKey === snapshotKey) {
    return { shouldApply: false, reason: "same-snapshot-key", snapshotKey };
  }

  return { shouldApply: true, reason: "snapshot-key-changed", snapshotKey };
}
