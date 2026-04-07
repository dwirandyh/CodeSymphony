export { deriveSelectedThreadUiState, useChatSession } from "./useChatSession";

export type {
  PendingMessageMutation,
  SnapshotSeedDecision,
  ThreadMetadataSnapshot,
  UseChatSessionOptions,
  SelectedThreadUiState,
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
  applyThreadModeUpdate,
  applyThreadPermissionModeUpdate,
} from "./snapshotSeed";
