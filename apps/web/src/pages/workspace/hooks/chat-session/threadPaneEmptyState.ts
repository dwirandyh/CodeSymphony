import type { ChatMessageListEmptyState } from "../../../../components/workspace/chat-message-list/ChatMessageList.types";

export function resolveThreadPaneMessageListEmptyState(params: {
  timelineItemCount: number;
  isOptimisticThread: boolean;
  messageCount: number;
  eventCount: number;
  statusSnapshot: { isLoading: boolean; isFetching: boolean; data: unknown };
  timelineSnapshot: { isLoading: boolean; isFetching: boolean; data: unknown };
}): ChatMessageListEmptyState | null {
  if (params.timelineItemCount > 0) {
    return null;
  }
  if (params.isOptimisticThread) {
    return "new-thread-empty";
  }

  const hasLocalConversationState = params.messageCount > 0 || params.eventCount > 0;
  if (hasLocalConversationState) {
    return null;
  }

  const statusPending =
    params.statusSnapshot.isLoading
    || (params.statusSnapshot.isFetching && params.statusSnapshot.data == null);
  const timelinePending =
    params.timelineSnapshot.isLoading
    || (params.timelineSnapshot.isFetching && params.timelineSnapshot.data == null);
  const timelineSnapshotReady = params.timelineSnapshot.data != null;

  // Status can refetch independently; once timeline snapshot is cached, keep the
  // empty thread visible instead of flashing the loading shimmer.
  if (timelinePending || (statusPending && !timelineSnapshotReady)) {
    return "loading-thread";
  }

  return "existing-thread-empty";
}

export function explainThreadPaneEmptyStatePending(params: {
  statusSnapshot: { isLoading: boolean; isFetching: boolean; data: unknown };
  timelineSnapshot: { isLoading: boolean; isFetching: boolean; data: unknown };
}) {
  const statusPending =
    params.statusSnapshot.isLoading
    || (params.statusSnapshot.isFetching && params.statusSnapshot.data == null);
  const timelinePending =
    params.timelineSnapshot.isLoading
    || (params.timelineSnapshot.isFetching && params.timelineSnapshot.data == null);
  const timelineSnapshotReady = params.timelineSnapshot.data != null;
  const emptyStateWouldShowLoading = timelinePending || (statusPending && !timelineSnapshotReady);
  return { statusPending, timelinePending, timelineSnapshotReady, emptyStateWouldShowLoading };
}
