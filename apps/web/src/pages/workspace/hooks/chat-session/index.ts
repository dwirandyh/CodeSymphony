export { useChatSession } from "./useChatSession";

export type {
  PendingMessageMutation,
  LoadOlderHistoryRequestMetadata,
  LoadOlderHistoryResult,
  SemanticHydrationGateMetadata,
  AutoBackfillStopReason,
  AutoBackfillLoopOutcome,
  AutoBackfillLoopInput,
  HydrationBackfillPolicy,
  SnapshotSeedDecision,
  ThreadMetadataSnapshot,
  UseChatSessionOptions,
} from "./useChatSession.types";

export {
  resolveHydrationBackfillPolicy,
  shouldAutoBackfillOnHydration,
  buildAutoBackfillSnapshotKey,
  shouldInvalidateSnapshotImmediatelyAfterSubmit,
  buildAutoBackfillLaunchKey,
  resolveSnapshotSeedDecision,
} from "./hydrationUtils";

export {
  prependUniqueMessages,
  prependUniqueEvents,
  insertAllEvents,
  applyMessageMutations,
  mergeEventsWithCurrent,
} from "./messageEventMerge";

export {
  applySnapshotSeed,
  extractLatestThreadMetadata,
  applyThreadTitleUpdate,
} from "./snapshotSeed";

export { runAutoBackfillLoop } from "./useAutoBackfill";
