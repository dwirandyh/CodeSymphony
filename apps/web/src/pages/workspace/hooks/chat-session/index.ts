export { useChatSession } from "./useChatSession";

export type {
  PendingMessageMutation,
  SnapshotSeedDecision,
  ThreadMetadataSnapshot,
  UseChatSessionOptions,
} from "./useChatSession.types";

export {
  buildSnapshotKey,
  shouldInvalidateSnapshotImmediatelyAfterSubmit,
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
