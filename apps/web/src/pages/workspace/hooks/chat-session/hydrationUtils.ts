import type { ChatThreadSnapshot } from "@codesymphony/shared-types";
import type {
  HydrationBackfillPolicy,
  SnapshotSeedDecision,
} from "./useChatSession.types";

export function resolveHydrationBackfillPolicy(
  policy: HydrationBackfillPolicy | undefined,
): HydrationBackfillPolicy {
  return policy ?? "manual";
}

export function shouldAutoBackfillOnHydration(
  snapshot: ChatThreadSnapshot,
  timelineHasIncompleteCoverage: boolean,
): boolean {
  return timelineHasIncompleteCoverage && snapshot.coverage.nextBeforeIdx != null;
}

export function buildAutoBackfillSnapshotKey(snapshot: ChatThreadSnapshot): string {
  const { watermarks, coverage } = snapshot;
  return [
    watermarks.newestSeq ?? "null",
    watermarks.newestIdx ?? "null",
    coverage.eventsStatus,
    coverage.recommendedBackfill ? "1" : "0",
    coverage.nextBeforeIdx ?? "null",
  ].join(":");
}

export function shouldInvalidateSnapshotImmediatelyAfterSubmit(): boolean {
  return false;
}

export function buildAutoBackfillLaunchKey(params: {
  snapshotKey: string;
  coverageNextBeforeIdx: number | null;
}): string {
  const { snapshotKey, coverageNextBeforeIdx } = params;
  return [
    snapshotKey,
    coverageNextBeforeIdx ?? "null",
  ].join("|");
}

export function resolveSnapshotSeedDecision(params: {
  selectedThreadId: string | null;
  queriedThreadSnapshot: ChatThreadSnapshot | undefined;
  threadChanged: boolean;
  lastAppliedSnapshotKey: string | null;
}): SnapshotSeedDecision {
  const { selectedThreadId, queriedThreadSnapshot, threadChanged, lastAppliedSnapshotKey } = params;
  if (!selectedThreadId || !queriedThreadSnapshot) {
    return { shouldApply: false, reason: "no-thread-or-snapshot", snapshotKey: null };
  }

  const snapshotKey = buildAutoBackfillSnapshotKey(queriedThreadSnapshot);
  if (threadChanged) {
    return { shouldApply: true, reason: "thread-changed", snapshotKey };
  }

  if (lastAppliedSnapshotKey === snapshotKey) {
    return { shouldApply: false, reason: "same-snapshot-key", snapshotKey };
  }

  return { shouldApply: true, reason: "snapshot-key-changed", snapshotKey };
}
