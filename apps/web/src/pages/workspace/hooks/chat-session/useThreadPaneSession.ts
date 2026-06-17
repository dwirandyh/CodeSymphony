import { useEffect, useMemo, useRef, useState } from "react";
import {
  explainThreadPaneEmptyStatePending,
  resolveThreadPaneMessageListEmptyState,
} from "./threadPaneEmptyState";
import { logWorkspaceEmptyStateResolution } from "../../../../lib/workspaceUiDiagnose";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AttachmentInput,
  ChatEvent,
  ChatMessage,
  ChatMode,
  ChatQueuedMessage,
  ChatThread,
  ChatThreadKind,
  ChatThreadPermissionMode,
  CliAgent,
  ProviderOptionSelection,
  UpdateChatThreadAgentSelectionInput,
} from "@codesymphony/shared-types";
import { api } from "../../../../lib/api";
import { queryKeys } from "../../../../lib/queryKeys";
import { getThreadCollections } from "../../../../collections/threadCollections";
import { isOptimisticThreadId } from "../../../../lib/threadIds";
import { resolveAgentDefaultModel } from "../../../../lib/agentModelDefaults";
import { useThreadStatusSnapshot } from "../../../../hooks/queries/useThreadStatusSnapshot";
import { useThreadSnapshot } from "../../../../hooks/queries/useThreadSnapshot";
import { useWorkspaceTimeline } from "../workspace-timeline";
import type {
  ChatMessageListEmptyState,
  ChatTimelineItem,
} from "../../../../components/workspace/chat-message-list/ChatMessageList.types";
import type { WorktreeThreadUiStatus } from "../worktreeThreadStatus";
import {
  deriveThreadUiStatusFromEvents,
  hasRunningAssistantActivity,
} from "../worktreeThreadStatus";
import { usePendingGates } from "../usePendingGates";
import { useThreadEventStream } from "./useThreadEventStream";
import { cloneSortedIfNeeded, toPlainChatEvent, toPlainChatMessage } from "./threadLiveData";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_EVENTS: ChatEvent[] = [];
const EMPTY_QUEUED: ChatQueuedMessage[] = [];

function upsertQueuedMessage(
  current: ChatQueuedMessage[] | undefined,
  queuedMessage: ChatQueuedMessage,
): ChatQueuedMessage[] {
  if (!current) {
    return [queuedMessage];
  }
  const existingIndex = current.findIndex((message) => message.id === queuedMessage.id);
  if (existingIndex === -1) {
    return [...current, queuedMessage];
  }
  const updated = [...current];
  updated[existingIndex] = queuedMessage;
  return updated;
}

function applyQueuedDispatchCancellation(
  queue: ChatQueuedMessage[],
  queueMessageId: string,
): ChatQueuedMessage[] {
  return queue.map((message) => message.id === queueMessageId
    ? { ...message, status: "queued", dispatchRequestedAt: null }
    : message);
}

/**
 * Per-pane chat session. Each split pane owns one instance, scoped to a single
 * `threadId`. Unlike the worktree-level `useChatSession` (which collapses all
 * derivation onto one globally-selected thread), this hook keeps every shared
 * ref/stream local to the instance so two panes run fully independent threads.
 *
 * Cross-cutting concerns (thread list, selection, lifecycle, sending) stay in
 * the parent and are passed in via {@link UseThreadPaneSessionDeps}. Sending is
 * delegated through `onSubmitMessage(content, mode, attachments, threadId)` so a
 * pane always targets its own thread regardless of which pane is focused.
 */
export interface UseThreadPaneSessionDeps {
  /** The thread record (from the parent's thread list), or null while resolving. */
  thread: ChatThread | null;
  worktreeId: string | null;
  repositoryId: string | null;
  worktreeOperational: boolean;
  worktreePath: string | null;
  onSubmitMessage: (
    content: string,
    mode: ChatMode,
    attachments: Array<AttachmentInput & { sizeBytes?: number; isInline?: boolean }>,
    targetThreadId: string,
  ) => Promise<boolean>;
  // Cross-cutting thread-list mutations stay in the parent useChatSession; each
  // is thread-explicit so a pane always targets its OWN thread regardless of
  // which pane is globally focused.
  onSetThreadMode: (threadId: string, mode: ChatMode) => Promise<void>;
  onSetThreadAgentSelection: (
    threadId: string,
    selection: UpdateChatThreadAgentSelectionInput,
  ) => Promise<void>;
  onSetThreadPermissionMode: (
    threadId: string,
    permissionMode: ChatThreadPermissionMode,
  ) => Promise<void>;
  onStopAssistantRun: (threadId: string) => Promise<void>;
  onError: (msg: string | null) => void;
  onBranchRenamed?: (worktreeId: string, newBranch: string) => void;
}

export interface ThreadPaneSession {
  threadId: string;
  thread: ChatThread | null;
  messages: ChatMessage[];
  events: ChatEvent[];
  timelineItems: ChatTimelineItem[];
  messageListEmptyState: ChatMessageListEmptyState | null;
  threadUiStatus: WorktreeThreadUiStatus;
  showStopAction: boolean;
  stoppingRun: boolean;
  gates: ReturnType<typeof usePendingGates>;
  composerAgent: CliAgent;
  composerModel: string;
  composerModelProviderId: string | null;
  composerModelOptions: ProviderOptionSelection[];
  composerModelOptionsPerModel: Record<string, ProviderOptionSelection[]>;
  composerMode: ChatMode;
  composerModeLocked: boolean;
  composerPermissionMode: ChatThreadPermissionMode;
  composerDisabled: boolean;
  threadKind: ChatThreadKind | null;
  submitMessage: (
    content: string,
    mode: ChatMode,
    attachments: Array<AttachmentInput & { sizeBytes?: number; isInline?: boolean }>,
  ) => Promise<boolean>;
  setComposerMode: (mode: ChatMode) => Promise<void>;
  setComposerAgentSelection: (selection: UpdateChatThreadAgentSelectionInput) => Promise<void>;
  setComposerPermissionMode: (permissionMode: ChatThreadPermissionMode) => Promise<void>;
  stopAssistantRun: () => Promise<void>;
  queuedMessages: ChatQueuedMessage[];
  queueDraft: (
    content: string,
    mode: ChatMode,
    attachments: Array<AttachmentInput & { sizeBytes?: number; isInline?: boolean }>,
  ) => Promise<boolean>;
  updateQueuedDraft: (queueMessageId: string, content: string) => Promise<boolean>;
  dispatchQueuedDraft: (queueMessageId: string) => Promise<void>;
  cancelQueuedDraftDispatch: (queueMessageId: string) => Promise<void>;
  deleteQueuedDraft: (queueMessageId: string) => Promise<void>;
}

export function useThreadPaneSession(
  threadId: string,
  deps: UseThreadPaneSessionDeps,
): ThreadPaneSession {
  const {
    thread,
    worktreeId,
    repositoryId,
    worktreeOperational,
    onSubmitMessage,
    onSetThreadMode,
    onSetThreadAgentSelection,
    onSetThreadPermissionMode,
    onStopAssistantRun,
    onError,
    onBranchRenamed,
  } = deps;

  const isOptimistic = isOptimisticThreadId(threadId);
  const dataThreadId = isOptimistic ? null : threadId;

  const queryClient = useQueryClient();

  // ── Per-instance refs (the entanglement source in useChatSession). Keeping
  // them local is what lets two panes coexist without colliding. ──
  const streamingMessageIdsRef = useRef<Set<string>>(new Set());
  const stickyRawFallbackMessageIdsRef = useRef<Set<string>>(new Set());
  const renderDecisionByMessageIdRef = useRef<Map<string, string>>(new Map());
  const loggedOrphanEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const claimedContextEventIdsByThreadMessageRef = useRef<Map<string, Set<string>>>(new Map());
  const locallyDeletedThreadIdsRef = useRef<Set<string>>(new Set());
  const activeThreadIdRef = useRef<string | null>(threadId);
  activeThreadIdRef.current = threadId;

  const [sendingMessage, setSendingMessage] = useState(false);
  const [stoppingThreadId, setStoppingThreadId] = useState<string | null>(null);
  const [stopRequestedThreadId, setStopRequestedThreadId] = useState<string | null>(null);
  const [waitingAssistant, setWaitingAssistant] = useState<{ threadId: string; afterIdx: number } | null>(null);
  const waitingAssistantRef = useRef<{ threadId: string; afterIdx: number } | null>(null);
  waitingAssistantRef.current = waitingAssistant;

  // Parent owns the thread list; the pane only needs to update its own record's
  // optimistic fields. A local setter keeps useThreadEventStream's contract
  // satisfied without leaking into the parent list.
  const [, setThreadsNoop] = useState<ChatThread[]>([]);

  const { data: liveMessages } = useLiveQuery(
    () => dataThreadId ? getThreadCollections(dataThreadId).messagesCollection : undefined,
    [dataThreadId],
  );
  const { data: liveEvents } = useLiveQuery(
    () => dataThreadId ? getThreadCollections(dataThreadId).eventsCollection : undefined,
    [dataThreadId],
  );

  const messages = useMemo(() => {
    if (!liveMessages || liveMessages.length === 0) {
      return EMPTY_MESSAGES;
    }
    const plain = (liveMessages as ChatMessage[]).map(toPlainChatMessage);
    return cloneSortedIfNeeded(plain, (left, right) => left.seq - right.seq);
  }, [liveMessages]);

  const events = useMemo(() => {
    if (!liveEvents || liveEvents.length === 0) {
      return EMPTY_EVENTS;
    }
    const plain = (liveEvents as ChatEvent[]).map(toPlainChatEvent);
    return cloneSortedIfNeeded(plain, (left, right) => left.idx - right.idx);
  }, [liveEvents]);

  // ── Per-thread queued-draft list. Owned self-contained (mirroring
  // usePendingGates' own-api pattern) so a pane drives its OWN thread's queue
  // regardless of which pane is globally focused. ──
  const { data: queuedMessages = EMPTY_QUEUED } = useQuery({
    queryKey: dataThreadId ? queryKeys.threads.queue(dataThreadId) : ["threads", "__no_thread__", "queue"],
    queryFn: () => api.listQueuedMessages(dataThreadId!),
    enabled: dataThreadId != null,
  });

  const selectedThreadIsPrMr = thread?.kind === "review";

  useThreadEventStream({
    selectedThreadId: dataThreadId,
    selectedWorktreeId: worktreeId,
    repositoryId,
    selectedThreadIsPrMr,
    locallyDeletedThreadIdsRef,
    activeThreadIdRef,
    waitingAssistantRef,
    setThreads: setThreadsNoop,
    setWaitingAssistant,
    setStoppingThreadId,
    setStopRequestedThreadId,
    streamingMessageIdsRef,
    stickyRawFallbackMessageIdsRef,
    renderDecisionByMessageIdRef,
    onError,
    onBranchRenamed,
  });

  const startWaitingAssistant = (waitForThreadId: string) => {
    const afterIdx = events[events.length - 1]?.idx ?? -1;
    setWaitingAssistant({ threadId: waitForThreadId, afterIdx });
  };
  const clearWaitingAssistantForThread = (clearThreadId: string) => {
    setWaitingAssistant((current) => (current?.threadId === clearThreadId ? null : current));
  };

  const gates = usePendingGates(dataThreadId, {
    onError,
    startWaitingAssistant,
    clearWaitingAssistantForThread,
  });

  // Clear the waiting-assistant marker once a real activity event lands.
  useEffect(() => {
    if (!dataThreadId) return;
    setWaitingAssistant((current) => {
      if (!current || current.threadId !== dataThreadId) return current;
      const cleared = events.some(
        (event) => event.idx > current.afterIdx && hasRunningAssistantActivity([event]),
      );
      return cleared ? null : current;
    });
  }, [events, dataThreadId]);

  const statusSnapshot = useThreadStatusSnapshot(dataThreadId);
  const timelineSnapshot = useThreadSnapshot(dataThreadId, { mode: "compact" });

  const timelineRefs = useMemo(() => ({
    streamingMessageIds: streamingMessageIdsRef.current,
    stickyRawFallbackMessageIds: stickyRawFallbackMessageIdsRef.current,
    renderDecisionByMessageId: renderDecisionByMessageIdRef.current,
    loggedOrphanEventIdsByThread: loggedOrphanEventIdsByThreadRef.current,
    claimedContextEventIdsByThreadMessage: claimedContextEventIdsByThreadMessageRef.current,
  }), []);

  const timeline = useWorkspaceTimeline(messages, events, dataThreadId, timelineRefs, {
    disabled: dataThreadId == null,
  });
  const timelineItems = timeline.items;

  // ── Per-thread UI status. Derived purely from this thread's own state, so a
  // non-focused pane reports its true status (not the focused thread's). ──
  const threadUiStatus = useMemo<WorktreeThreadUiStatus>(() => {
    const optimisticRunning = sendingMessage || waitingAssistant?.threadId === threadId;
    const eventStatus = deriveThreadUiStatusFromEvents(events, thread?.active ?? false);
    if (eventStatus !== "idle") {
      return eventStatus;
    }
    if (optimisticRunning) {
      return "running";
    }
    return "idle";
  }, [events, sendingMessage, thread?.active, threadId, waitingAssistant]);

  const threadIsRunning = threadUiStatus === "running";
  const hasStreamingAssistant = streamingMessageIdsRef.current.size > 0;
  const showStopAction = threadIsRunning || hasStreamingAssistant;
  const stoppingRun = stoppingThreadId === threadId || stopRequestedThreadId === threadId;

  // ── Composer fields. All derived from this thread's own record + status, so
  // each pane drives an independent composer (agent/model/mode/permission). ──
  const composerAgent: CliAgent = thread?.agent ?? "claude";
  const composerModel = thread?.model ?? resolveAgentDefaultModel(composerAgent);
  const composerModelProviderId = thread?.modelProviderId ?? null;
  const composerModelOptions = thread?.modelOptions ?? [];
  const composerModelOptionsPerModel = thread?.modelOptionsPerModel ?? {};
  const composerPermissionMode = thread?.permissionMode ?? "default";
  const composerMode: ChatMode = threadUiStatus === "review_plan"
    ? "plan"
    : thread?.mode ?? "default";
  const composerModeLocked = threadUiStatus !== "idle" && threadUiStatus !== "running";
  const composerDisabled =
    dataThreadId == null
    || !worktreeOperational
    || sendingMessage
    || (threadUiStatus !== "idle" && threadUiStatus !== "running");
  const threadKind = thread?.kind ?? null;

  // ── Empty-state. The split-pane shimmer bug came from hard-coding
  // "loading-thread" for non-focused panes. Here it is derived from this
  // thread's real loading/empty state. ──
  const messageListEmptyState: ChatMessageListEmptyState | null = useMemo(
    () => resolveThreadPaneMessageListEmptyState({
      timelineItemCount: timelineItems.length,
      isOptimisticThread: isOptimistic,
      messageCount: messages.length,
      eventCount: events.length,
      statusSnapshot,
      timelineSnapshot,
    }),
    [
      timelineItems.length,
      isOptimistic,
      messages.length,
      events.length,
      statusSnapshot.isLoading,
      statusSnapshot.isFetching,
      statusSnapshot.data,
      timelineSnapshot.isLoading,
      timelineSnapshot.isFetching,
      timelineSnapshot.data,
    ],
  );

  const paneEmptyStateDiagnoseSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    const pending = explainThreadPaneEmptyStatePending({
      statusSnapshot,
      timelineSnapshot,
    });
    const signature = JSON.stringify({
      messageListEmptyState,
      threadId,
      ...pending,
    });
    if (paneEmptyStateDiagnoseSignatureRef.current === signature) {
      return;
    }
    paneEmptyStateDiagnoseSignatureRef.current = signature;
    logWorkspaceEmptyStateResolution("useThreadPaneSession", {
      resolved: messageListEmptyState,
      threadId,
      timelineItemCount: timelineItems.length,
      messageCount: messages.length,
      eventCount: events.length,
      statusPending: pending.statusPending,
      timelinePending: pending.timelinePending,
      threadSnapshotLoading: timelineSnapshot.isLoading,
      threadSnapshotFetching: timelineSnapshot.isFetching,
      queriedThreadSnapshotPresent: timelineSnapshot.data != null,
      threadStatusSnapshotLoading: statusSnapshot.isLoading,
      threadStatusSnapshotFetching: statusSnapshot.isFetching,
      composerDisabled,
    });
  }, [
    composerDisabled,
    events.length,
    messageListEmptyState,
    messages.length,
    statusSnapshot.data,
    statusSnapshot.isFetching,
    statusSnapshot.isLoading,
    threadId,
    timelineItems.length,
    timelineSnapshot.data,
    timelineSnapshot.isFetching,
    timelineSnapshot.isLoading,
  ]);

  const submitMessage = (
    content: string,
    mode: ChatMode,
    attachments: Array<AttachmentInput & { sizeBytes?: number; isInline?: boolean }>,
  ) => {
    if (!worktreeOperational) {
      return Promise.resolve(false);
    }
    setSendingMessage(true);
    startWaitingAssistant(threadId);
    return onSubmitMessage(content, mode, attachments, threadId)
      .finally(() => setSendingMessage(false));
  };

  // Composer mutations delegate to the parent's thread-explicit methods, always
  // binding this pane's own threadId so focus never decides the target.
  const setComposerMode = (mode: ChatMode) => onSetThreadMode(threadId, mode);
  const setComposerAgentSelection = (selection: UpdateChatThreadAgentSelectionInput) =>
    onSetThreadAgentSelection(threadId, selection);
  const setComposerPermissionMode = (permissionMode: ChatThreadPermissionMode) =>
    onSetThreadPermissionMode(threadId, permissionMode);
  const stopAssistantRun = () => onStopAssistantRun(threadId);

  // ── Per-thread queued-draft mutations. Each targets this pane's OWN threadId
  // + cache key, so two panes manage independent queues. ──
  const queueKeyFor = (id: string) => queryKeys.threads.queue(id);

  const queueDraft = async (
    content: string,
    mode: ChatMode,
    attachments: Array<AttachmentInput & { sizeBytes?: number; isInline?: boolean }>,
  ): Promise<boolean> => {
    if (!dataThreadId || !worktreeOperational) {
      return false;
    }
    const attachmentsToSend: AttachmentInput[] = attachments.map((att) => ({
      id: att.id,
      filename: att.filename,
      mimeType: att.mimeType,
      content: att.content,
      source: att.source,
    }));
    onError(null);
    try {
      const queued = await api.queueMessage(dataThreadId, {
        content,
        mode,
        attachments: attachmentsToSend,
        expectedWorktreeId: thread?.worktreeId ?? worktreeId ?? undefined,
      });
      queryClient.setQueryData<ChatQueuedMessage[]>(
        queueKeyFor(dataThreadId),
        (current) => upsertQueuedMessage(current, queued),
      );
      void queryClient.invalidateQueries({ queryKey: queueKeyFor(dataThreadId) });
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to queue draft");
      return false;
    }
  };

  const updateQueuedDraft = async (queueMessageId: string, content: string): Promise<boolean> => {
    if (!dataThreadId) return false;
    const key = queueKeyFor(dataThreadId);
    const previous = queryClient.getQueryData<ChatQueuedMessage[]>(key) ?? [];
    queryClient.setQueryData<ChatQueuedMessage[]>(
      key,
      previous.map((message) => message.id === queueMessageId ? { ...message, content } : message),
    );
    try {
      await api.updateQueuedMessage(dataThreadId, queueMessageId, { content });
      void queryClient.invalidateQueries({ queryKey: key });
      return true;
    } catch (error) {
      queryClient.setQueryData(key, previous);
      onError(error instanceof Error ? error.message : "Failed to update queued draft");
      return false;
    }
  };

  const dispatchQueuedDraft = async (queueMessageId: string): Promise<void> => {
    if (!dataThreadId) return;
    const key = queueKeyFor(dataThreadId);
    const previous = queryClient.getQueryData<ChatQueuedMessage[]>(key) ?? [];
    queryClient.setQueryData<ChatQueuedMessage[]>(
      key,
      previous.map((message) => message.id === queueMessageId
        ? {
          ...message,
          status: message.status === "dispatching" ? "dispatching" : "dispatch_requested",
          dispatchRequestedAt: message.dispatchRequestedAt ?? new Date().toISOString(),
        }
        : message),
    );
    try {
      await api.requestQueuedMessageDispatch(dataThreadId, queueMessageId);
      void queryClient.invalidateQueries({ queryKey: key });
    } catch (error) {
      queryClient.setQueryData(key, previous);
      onError(error instanceof Error ? error.message : "Failed to dispatch queued draft");
    }
  };

  const cancelQueuedDraftDispatch = async (queueMessageId: string): Promise<void> => {
    if (!dataThreadId) return;
    const key = queueKeyFor(dataThreadId);
    const previous = queryClient.getQueryData<ChatQueuedMessage[]>(key) ?? [];
    queryClient.setQueryData<ChatQueuedMessage[]>(
      key,
      applyQueuedDispatchCancellation(previous, queueMessageId),
    );
    try {
      await api.cancelQueuedMessageDispatch(dataThreadId, queueMessageId);
      void queryClient.invalidateQueries({ queryKey: key });
    } catch (error) {
      queryClient.setQueryData(key, previous);
      onError(error instanceof Error ? error.message : "Failed to cancel queued send");
    }
  };

  const deleteQueuedDraft = async (queueMessageId: string): Promise<void> => {
    if (!dataThreadId) return;
    const key = queueKeyFor(dataThreadId);
    const previous = queryClient.getQueryData<ChatQueuedMessage[]>(key) ?? [];
    queryClient.setQueryData<ChatQueuedMessage[]>(
      key,
      previous.filter((message) => message.id !== queueMessageId),
    );
    try {
      await api.deleteQueuedMessage(dataThreadId, queueMessageId);
      void queryClient.invalidateQueries({ queryKey: key });
    } catch (error) {
      queryClient.setQueryData(key, previous);
      onError(error instanceof Error ? error.message : "Failed to delete queued draft");
    }
  };

  return {
    threadId,
    thread,
    messages,
    events,
    timelineItems,
    messageListEmptyState,
    threadUiStatus,
    showStopAction,
    stoppingRun,
    gates,
    composerAgent,
    composerModel,
    composerModelProviderId,
    composerModelOptions,
    composerModelOptionsPerModel,
    composerMode,
    composerModeLocked,
    composerPermissionMode,
    composerDisabled,
    threadKind,
    submitMessage,
    setComposerMode,
    setComposerAgentSelection,
    setComposerPermissionMode,
    stopAssistantRun,
    queuedMessages,
    queueDraft,
    updateQueuedDraft,
    dispatchQueuedDraft,
    cancelQueuedDraftDispatch,
    deleteQueuedDraft,
  };
}
