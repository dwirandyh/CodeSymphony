import {
  startTransition,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ChatEvent,
  ChatMessage,
  ChatThread,
  ChatThreadStatusSnapshot,
  ChatTimelineSnapshot,
} from "@codesymphony/shared-types";
import { api } from "../../../../lib/api";
import { debugLog } from "../../../../lib/debugLog";
import { queryKeys } from "../../../../lib/queryKeys";
import { logService } from "../../../../lib/logService";
import { pushRenderDebug } from "../../../../lib/renderDebug";
import { isOptimisticThreadId } from "../../../../lib/threadIds";
import {
  getThreadCollections,
  getThreadEventsCollection,
  getThreadMessagesCollection,
} from "../../../../collections/threadCollections";
import { hydrateThreadFromSnapshot } from "../../../../collections/threadHydrator";
import {
  allocateNextThreadMessageSeq,
  clearThreadReconnectTimer,
  getThreadLastEventIdx,
  getThreadLastMessageSeq,
  getThreadStreamConnectionState,
  getThreadReconnectAttempts,
  hasSeenThreadEvent,
  incrementThreadReconnectAttempts,
  markThreadEventSeen,
  markThreadStreamDisposed,
  replaceSeenThreadEventIds,
  resetThreadReconnectAttempts,
  setThreadLastEventIdx,
  setThreadLastMessageSeq,
  setThreadStreamConnectionState,
  setThreadReconnectTimer,
  setThreadThinkingActive,
} from "../../../../collections/threadStreamState";
import { EVENT_TYPES } from "../../constants";
import {
  GIT_STATUS_INVALIDATION_EVENT_TYPES,
  isMetadataToolEvent,
  payloadStringOrNull,
  shouldClearWaitingAssistantOnEvent,
} from "../../eventUtils";
import type { PendingMessageMutation } from "./useChatSession.types";
import { computeAssistantDeltaSuffix } from "./messageEventMerge";
import { applyThreadModeUpdate, applyThreadTitleUpdate } from "./snapshotSeed";
import { SNAPSHOT_INVALIDATION_EVENT_TYPES } from "../snapshotInvalidationEventTypes";
import { reduceStatusSnapshotWithEvent } from "../threadStatusSnapshotCache";
import type { ThreadCompletionAttentionEvent } from "../useCompletionAttention";
import { markWorktreeGitStatusChanged } from "../../../../hooks/queries/useGitStatus";
import { requestRepositoryReviewsLiveRefresh } from "../../../../hooks/queries/useRepositoryReviews";

const LIVE_ACTIVITY_EVENT_TYPES = new Set<ChatEvent["type"]>([
  "message.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "todo.updated",
  "permission.requested",
  "question.requested",
  "plan.created",
]);

const STREAM_WATCHDOG_INTERVAL_MS = 2_000;
const STREAM_STALE_THRESHOLD_MS = 7_000;
const STREAM_CONNECTING_RESTART_THRESHOLD_MS = 15_000;

function getSnapshotNewestEventIdx(snapshot: ChatTimelineSnapshot): number | null {
  return snapshot.newestIdx ?? snapshot.events[snapshot.events.length - 1]?.idx ?? null;
}

function isLiveActivityEvent(event: ChatEvent): boolean {
  return LIVE_ACTIVITY_EVENT_TYPES.has(event.type) && !isMetadataToolEvent(event);
}

function getNowMs(): number {
  return Date.now();
}

function isDocumentForegrounded() {
  if (typeof document === "undefined") {
    return true;
  }

  if (document.visibilityState === "visible") {
    return true;
  }

  return typeof document.hasFocus === "function" && document.hasFocus();
}

interface UseThreadEventStreamParams {
  selectedThreadId: string | null;
  selectedWorktreeId: string | null;
  repositoryId: string | null;
  selectedThreadIsPrMr: boolean;
  locallyDeletedThreadIdsRef: MutableRefObject<Set<string>>;
  activeThreadIdRef: MutableRefObject<string | null>;
  waitingAssistantRef: MutableRefObject<{ threadId: string; afterIdx: number } | null>;
  setThreads: Dispatch<SetStateAction<ChatThread[]>>;
  setWaitingAssistant: Dispatch<SetStateAction<{ threadId: string; afterIdx: number } | null>>;
  setStoppingThreadId: Dispatch<SetStateAction<string | null>>;
  setStopRequestedThreadId: Dispatch<SetStateAction<string | null>>;
  streamingMessageIdsRef: MutableRefObject<Set<string>>;
  stickyRawFallbackMessageIdsRef: MutableRefObject<Set<string>>;
  renderDecisionByMessageIdRef: MutableRefObject<Map<string, string>>;
  onError: (msg: string | null) => void;
  onBranchRenamed?: (worktreeId: string, newBranch: string) => void;
  onCompletionAttentionEvent?: (event: ThreadCompletionAttentionEvent) => void;
}

function syncThreadStreamCursorFromSnapshot(threadId: string, snapshot: ChatTimelineSnapshot) {
  const snapshotNewestIdx = getSnapshotNewestEventIdx(snapshot);
  const localNewestIdx = getThreadLastEventIdx(threadId);

  if (
    localNewestIdx != null
    && snapshotNewestIdx != null
    && snapshotNewestIdx < localNewestIdx
  ) {
    return;
  }

  if (snapshot.events.length > 0) {
    replaceSeenThreadEventIds(threadId, snapshot.events.map((event) => event.id));
  }

  if (snapshotNewestIdx != null) {
    setThreadLastEventIdx(threadId, snapshotNewestIdx);
  }
}

function clearWaitingAssistantFromRemoteSnapshot(params: {
  threadId: string;
  snapshot: ChatTimelineSnapshot;
  setWaitingAssistant: Dispatch<SetStateAction<{ threadId: string; afterIdx: number } | null>>;
}) {
  const snapshotNewestIdx = getSnapshotNewestEventIdx(params.snapshot);
  if (snapshotNewestIdx == null) {
    return;
  }

  params.setWaitingAssistant((current) => {
    if (!current || current.threadId !== params.threadId || snapshotNewestIdx <= current.afterIdx) {
      return current;
    }

    return null;
  });
}

function syncThreadStreamCursorFromStatus(threadId: string, snapshot: ChatThreadStatusSnapshot) {
  const snapshotNewestIdx = snapshot.newestIdx ?? null;
  const localNewestIdx = getThreadLastEventIdx(threadId);

  if (localNewestIdx == null) {
    return;
  }

  if (
    snapshotNewestIdx != null
    && snapshotNewestIdx < localNewestIdx
  ) {
    return;
  }

  if (snapshotNewestIdx != null) {
    setThreadLastEventIdx(threadId, snapshotNewestIdx);
  }
}

function summarizeLocalThreadCollections(threadId: string) {
  const { eventsCollection, messagesCollection } = getThreadCollections(threadId);
  const events = eventsCollection.toArray as ChatEvent[];
  const messages = messagesCollection.toArray as ChatMessage[];

  return {
    messagesCount: messages.length,
    eventsCount: events.length,
    firstMessageSeq: messages[0]?.seq ?? null,
    lastMessageSeq: messages[messages.length - 1]?.seq ?? null,
    firstEventIdx: events[0]?.idx ?? null,
    lastEventIdx: events[events.length - 1]?.idx ?? null,
    cursorEventIdx: getThreadLastEventIdx(threadId),
    cursorMessageSeq: getThreadLastMessageSeq(threadId),
  };
}

function flushPendingEventsToCollection(threadId: string, pendingEvents: ChatEvent[]) {
  if (pendingEvents.length === 0) {
    return;
  }

  const eventsCollection = getThreadEventsCollection(threadId);
  const existingEventIds = new Set((eventsCollection.toArray as ChatEvent[]).map((event) => event.id));
  const insertableEvents = pendingEvents.filter((event) => !existingEventIds.has(event.id));

  if (insertableEvents.length === 0) {
    return;
  }

  eventsCollection.insert(insertableEvents);
  setThreadLastEventIdx(threadId, insertableEvents[insertableEvents.length - 1]?.idx ?? null);
}

function flushPendingMessageMutationsToCollection(
  threadId: string,
  pendingMutations: PendingMessageMutation[],
) {
  if (pendingMutations.length === 0) {
    return;
  }

  const messagesCollection = getThreadMessagesCollection(threadId);
  const currentMessages = messagesCollection.toArray as ChatMessage[];
  const currentMessagesById = new Map(currentMessages.map((message) => [message.id, message]));
  const insertRows = new Map<string, ChatMessage>();
  const updateContentById = new Map<string, string>();
  let nextSeq = getThreadLastMessageSeq(threadId) ?? currentMessages[currentMessages.length - 1]?.seq ?? 0;

  const getKnownMessage = (messageId: string) => {
    const inserted = insertRows.get(messageId);
    if (inserted) {
      return inserted;
    }

    const current = currentMessagesById.get(messageId);
    if (!current) {
      return null;
    }

    const updatedContent = updateContentById.get(messageId);
    if (updatedContent == null) {
      return current;
    }

    return {
      ...current,
      content: updatedContent,
    };
  };

  for (const mutation of pendingMutations) {
    if (mutation.kind === "ensure-placeholder") {
      if (getKnownMessage(mutation.id)) {
        continue;
      }

      nextSeq = allocateNextThreadMessageSeq(threadId, nextSeq);
      insertRows.set(mutation.id, {
        id: mutation.id,
        threadId: mutation.threadId,
        seq: nextSeq,
        role: "assistant",
        content: "",
        attachments: [],
        createdAt: new Date().toISOString(),
      });
      continue;
    }

    const knownMessage = getKnownMessage(mutation.id);
    if (!knownMessage) {
      nextSeq = allocateNextThreadMessageSeq(threadId, nextSeq);
      insertRows.set(mutation.id, {
        id: mutation.id,
        threadId: mutation.threadId,
        seq: nextSeq,
        role: mutation.role,
        content: mutation.delta,
        attachments: [],
        createdAt: new Date().toISOString(),
      });
      continue;
    }

    if (mutation.role === "user" || mutation.delta.length === 0) {
      continue;
    }

    const suffix = computeAssistantDeltaSuffix(knownMessage.content, mutation.delta);
    if (suffix.length === 0) {
      continue;
    }

    const nextContent = knownMessage.content + suffix;
    if (insertRows.has(mutation.id)) {
      insertRows.set(mutation.id, {
        ...insertRows.get(mutation.id)!,
        content: nextContent,
      });
      continue;
    }

    updateContentById.set(mutation.id, nextContent);
  }

  if (insertRows.size > 0) {
    messagesCollection.insert([...insertRows.values()]);
  }

  for (const [messageId, content] of updateContentById) {
    const current = currentMessagesById.get(messageId);
    if (!current || current.content === content) {
      continue;
    }

    messagesCollection.update(messageId, (draft) => {
      draft.content = content;
    });
  }

  setThreadLastMessageSeq(
    threadId,
    nextSeq > 0 ? nextSeq : currentMessages[currentMessages.length - 1]?.seq ?? null,
  );
}

export function useThreadEventStream(params: UseThreadEventStreamParams) {
  const {
    selectedThreadId,
    selectedWorktreeId,
    repositoryId,
    selectedThreadIsPrMr,
    locallyDeletedThreadIdsRef,
    activeThreadIdRef,
    waitingAssistantRef,
    setThreads,
    setWaitingAssistant,
    setStoppingThreadId,
    setStopRequestedThreadId,
    streamingMessageIdsRef,
    stickyRawFallbackMessageIdsRef,
    renderDecisionByMessageIdRef,
    onError,
    onBranchRenamed,
    onCompletionAttentionEvent,
  } = params;

  const queryClient = useQueryClient();
  const repositoryIdRef = useRef(repositoryId);
  const selectedThreadIsPrMrRef = useRef(selectedThreadIsPrMr);
  const pendingEventsRef = useRef<ChatEvent[]>([]);
  const pendingMessageMutationsRef = useRef<PendingMessageMutation[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const flushScheduledAtMsRef = useRef<number | null>(null);
  const flushSequenceRef = useRef(0);

  useEffect(() => {
    repositoryIdRef.current = repositoryId;
    selectedThreadIsPrMrRef.current = selectedThreadIsPrMr;
  }, [repositoryId, selectedThreadIsPrMr]);

  function clearPendingStreamBuffers() {
    pendingEventsRef.current = [];
    pendingMessageMutationsRef.current = [];
    flushScheduledAtMsRef.current = null;
    flushSequenceRef.current = 0;
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }

  useEffect(() => {
    if (!selectedThreadId || isOptimisticThreadId(selectedThreadId)) {
      clearPendingStreamBuffers();
      setWaitingAssistant(null);
      setStoppingThreadId(null);
      setStopRequestedThreadId(null);
      streamingMessageIdsRef.current = new Set();
      stickyRawFallbackMessageIdsRef.current = new Set();
      return;
    }

    getThreadCollections(selectedThreadId);
    clearPendingStreamBuffers();
    streamingMessageIdsRef.current = new Set();
    stickyRawFallbackMessageIdsRef.current = new Set();
    renderDecisionByMessageIdRef.current = new Map();
    setStoppingThreadId(null);
    setStopRequestedThreadId(null);
    markThreadStreamDisposed(selectedThreadId, false);

    let disposed = false;
    let stream: EventSource | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let resyncInFlight = false;
    let lastStreamActivityAtMs = getNowMs();
    let lastOpenAtMs: number | null = null;
    let lastHeartbeatAtMs: number | null = null;
    let lastChatEventAtMs: number | null = null;
    let lastResyncAttemptAtMs = 0;
    let heartbeatCount = 0;
    let chatEventCount = 0;
    let staleResyncCount = 0;
    let streamRestartCount = 0;

    const logLifecycle = (message: string, data?: Record<string, unknown>) => {
      debugLog("thread.stream.lifecycle", message, {
        threadId: selectedThreadId,
        worktreeId: selectedWorktreeId,
        ...(data ?? {}),
      }, { threadId: selectedThreadId, worktreeId: selectedWorktreeId });
    };

    const logEvent = (message: string, data?: Record<string, unknown>) => {
      debugLog("thread.stream.event", message, {
        threadId: selectedThreadId,
        ...(data ?? {}),
      }, { threadId: selectedThreadId });
    };

    const logWatchdog = (message: string, data?: Record<string, unknown>) => {
      debugLog("thread.stream.watchdog", message, {
        threadId: selectedThreadId,
        worktreeId: selectedWorktreeId,
        ...(data ?? {}),
      }, { threadId: selectedThreadId, worktreeId: selectedWorktreeId });
    };

    const getAgeMs = (timestampMs: number | null, nowMs = getNowMs()) => {
      return timestampMs == null ? null : nowMs - timestampMs;
    };

    const logHealth = (message: string, data?: Record<string, unknown>) => {
      const nowMs = getNowMs();
      debugLog("thread.stream.health", message, {
        threadId: selectedThreadId,
        worktreeId: selectedWorktreeId,
        connectionState: getThreadStreamConnectionState(selectedThreadId),
        eventSourceReadyState: stream?.readyState ?? null,
        localNewestIdx: getThreadLastEventIdx(selectedThreadId),
        lastActivityAgeMs: getAgeMs(lastStreamActivityAtMs, nowMs),
        lastOpenAgeMs: getAgeMs(lastOpenAtMs, nowMs),
        lastHeartbeatAgeMs: getAgeMs(lastHeartbeatAtMs, nowMs),
        lastChatEventAgeMs: getAgeMs(lastChatEventAtMs, nowMs),
        lastResyncAttemptAgeMs: getAgeMs(lastResyncAttemptAtMs || null, nowMs),
        heartbeatCount,
        chatEventCount,
        staleResyncCount,
        streamRestartCount,
        resyncInFlight,
        reconnectAttempts: getThreadReconnectAttempts(selectedThreadId),
        ...(data ?? {}),
      }, { threadId: selectedThreadId, worktreeId: selectedWorktreeId, force: true });
    };

    const updateConnectionState = (
      nextState: "connecting" | "healthy" | "reconnecting" | "exhausted" | "stale",
      message?: string,
      reason?: string,
      data?: Record<string, unknown>,
    ) => {
      const previousState = getThreadStreamConnectionState(selectedThreadId);
      if (previousState !== nextState) {
        debugLog("thread.stream.state", reason ?? "state.changed", {
          threadId: selectedThreadId,
          worktreeId: selectedWorktreeId,
          from: previousState,
          to: nextState,
          reconnectAttempts: getThreadReconnectAttempts(selectedThreadId),
          ...(message ? { errorMessage: message } : {}),
          ...(data ?? {}),
        }, { threadId: selectedThreadId, worktreeId: selectedWorktreeId, force: true });
      }
      setThreadStreamConnectionState(selectedThreadId, nextState, message);
    };

    const markStreamActivity = () => {
      lastStreamActivityAtMs = getNowMs();
    };

    const onHeartbeat = () => {
      if (disposed) {
        return;
      }

      heartbeatCount += 1;
      lastHeartbeatAtMs = getNowMs();
      markStreamActivity();
      if (heartbeatCount === 1 || heartbeatCount % 12 === 0) {
        logHealth("heartbeat.received");
      }
    };

    const closeStream = () => {
      if (!stream) {
        return;
      }

      for (const eventType of EVENT_TYPES) {
        stream.removeEventListener(eventType, onEvent as EventListener);
      }
      stream.removeEventListener("heartbeat", onHeartbeat as EventListener);
      stream.close();
      stream = null;
    };

    const resyncFromRemote = async (reason: string) => {
      if (disposed || resyncInFlight) {
        return;
      }

      resyncInFlight = true;
      staleResyncCount += reason === "stale-watchdog" ? 1 : 0;
      lastResyncAttemptAtMs = getNowMs();
      const localNewestIdxBefore = getThreadLastEventIdx(selectedThreadId);
      logHealth("resync.started", {
        reason,
      });
      logWatchdog("status.check.started", {
        reason,
        localNewestIdx: localNewestIdxBefore,
        streamReadyState: stream?.readyState ?? null,
      });

      try {
        const statusSnapshot = await api.getThreadStatusSnapshot(selectedThreadId);
        if (
          disposed
          || locallyDeletedThreadIdsRef.current.has(selectedThreadId)
          || activeThreadIdRef.current !== selectedThreadId
        ) {
          return;
        }

        queryClient.setQueryData(queryKeys.threads.statusSnapshot(selectedThreadId), statusSnapshot);

        const localNewestIdxAfterStatus = getThreadLastEventIdx(selectedThreadId);
        const remoteNewestIdx = statusSnapshot.newestIdx ?? null;
        logWatchdog("status.check.completed", {
          reason,
          localNewestIdx: localNewestIdxAfterStatus,
          remoteNewestIdx,
          remoteStatus: statusSnapshot.status,
        });

        if (
          remoteNewestIdx == null
          || (localNewestIdxAfterStatus != null && remoteNewestIdx <= localNewestIdxAfterStatus)
        ) {
          return;
        }

        logWatchdog("timeline.resync.started", {
          reason,
          localNewestIdx: localNewestIdxAfterStatus,
          remoteNewestIdx,
        });
        const timelineSnapshot = await api.getTimelineSnapshot(selectedThreadId);
        if (
          disposed
          || locallyDeletedThreadIdsRef.current.has(selectedThreadId)
          || activeThreadIdRef.current !== selectedThreadId
        ) {
          return;
        }

        queryClient.setQueryData(queryKeys.threads.timelineSnapshot(selectedThreadId), timelineSnapshot);
        if (timelineSnapshot.collectionsIncluded !== false) {
          hydrateThreadFromSnapshot({
            threadId: selectedThreadId,
            snapshot: timelineSnapshot,
            mode: "merge",
          });
        }
        clearWaitingAssistantFromRemoteSnapshot({
          threadId: selectedThreadId,
          snapshot: timelineSnapshot,
          setWaitingAssistant,
        });
        syncThreadStreamCursorFromSnapshot(selectedThreadId, timelineSnapshot);
        markStreamActivity();
        onError(null);
        logHealth("resync.completed", {
          reason,
          snapshotNewestIdx: timelineSnapshot.newestIdx,
          snapshotEventCount: timelineSnapshot.events.length,
        });
        logWatchdog("timeline.resync.completed", {
          reason,
          snapshotNewestIdx: timelineSnapshot.newestIdx,
          snapshotNewestSeq: timelineSnapshot.newestSeq,
          snapshotEventCount: timelineSnapshot.events.length,
          snapshotMessageCount: timelineSnapshot.messages.length,
        });
      } catch (error) {
        logHealth("resync.failed", {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
        logWatchdog("resync.failed", {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        resyncInFlight = false;
      }
    };

    const onEvent = (rawEvent: MessageEvent<string>) => {
      if (disposed) {
        return;
      }

      const payload = JSON.parse(rawEvent.data) as ChatEvent;
      if (hasSeenThreadEvent(selectedThreadId, payload.id)) {
        return;
      }

      markStreamActivity();
      lastChatEventAtMs = getNowMs();
      chatEventCount += 1;
      markThreadEventSeen(selectedThreadId, payload.id);
      setThreadLastEventIdx(selectedThreadId, payload.idx);
      logEvent("event.accepted", {
        eventId: payload.id,
        idx: payload.idx,
        type: payload.type,
        messageId: payloadStringOrNull(payload.payload.messageId),
      });
      pushRenderDebug({
        source: "WorkspacePage",
        event: "streamEventAccepted",
        messageId: String(payload.payload.messageId ?? ""),
        details: { eventId: payload.id, type: payload.type, idx: payload.idx, payload: payload.payload },
      });

      if (payload.type === "tool.started" || payload.type === "tool.output" || payload.type === "tool.finished") {
        logService.log("debug", "chat.stream", "Tool event received from stream", {
          threadId: selectedThreadId,
          eventId: payload.id,
          idx: payload.idx,
          type: payload.type,
          toolUseId: typeof payload.payload.toolUseId === "string" ? payload.payload.toolUseId : null,
          toolName: typeof payload.payload.toolName === "string" ? payload.payload.toolName : null,
          source: typeof payload.payload.source === "string" ? payload.payload.source : null,
        });
      }

      if (selectedWorktreeId && isLiveActivityEvent(payload)) {
        queryClient.setQueryData<ChatThread[] | undefined>(
          queryKeys.threads.list(selectedWorktreeId),
          (current) => {
            if (!current) {
              return current;
            }
            const index = current.findIndex((thread) => thread.id === selectedThreadId);
            if (index === -1 || current[index]?.active) {
              return current;
            }
            const updated = [...current];
            updated[index] = { ...updated[index]!, active: true };
            return updated;
          },
        );
      }

      setWaitingAssistant((current) => {
        if (!current || current.threadId !== selectedThreadId || payload.idx <= current.afterIdx) {
          return current;
        }
        return shouldClearWaitingAssistantOnEvent(payload) ? null : current;
      });

      pendingEventsRef.current.push(payload);

      const eventScopedMessageId = payload.type !== "message.delta"
        ? payloadStringOrNull(payload.payload.messageId)
        : null;
      if (eventScopedMessageId) {
        pendingMessageMutationsRef.current.push({
          kind: "ensure-placeholder",
          id: eventScopedMessageId,
          threadId: selectedThreadId,
        });
      }

      if (payload.type === "message.delta") {
        const messageId = String(payload.payload.messageId ?? "");
        const role =
          payload.payload.role === "assistant" || payload.payload.role === "user"
            ? payload.payload.role
            : "assistant";
        const delta = String(payload.payload.delta ?? "");

        if (messageId.length > 0) {
          if (role === "assistant") {
            streamingMessageIdsRef.current.add(messageId);
          }
          pendingMessageMutationsRef.current.push({
            kind: "message-delta",
            id: messageId,
            threadId: selectedThreadId,
            role,
            delta,
            eventIdx: payload.idx,
          });
        }
      }

      if (SNAPSHOT_INVALIDATION_EVENT_TYPES.has(payload.type)) {
        queryClient.setQueryData<ChatThreadStatusSnapshot | undefined>(
          queryKeys.threads.statusSnapshot(selectedThreadId),
          (current) => reduceStatusSnapshotWithEvent(current, payload),
        );
      }

      if (rafIdRef.current === null) {
        flushScheduledAtMsRef.current = getNowMs();
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          if (disposed) {
            return;
          }

          const pendingEvents = pendingEventsRef.current;
          const pendingMutations = pendingMessageMutationsRef.current;
          pendingEventsRef.current = [];
          pendingMessageMutationsRef.current = [];
          const scheduledAtMs = flushScheduledAtMsRef.current;
          flushScheduledAtMsRef.current = null;

          if (pendingEvents.length === 0 && pendingMutations.length === 0) {
            return;
          }

          const assistantDeltaMutationCount = pendingMutations.reduce((count, mutation) => {
            if (
              mutation.kind === "message-delta"
              && mutation.role === "assistant"
              && mutation.delta.length > 0
            ) {
              return count + 1;
            }
            return count;
          }, 0);
          const flushSequence = ++flushSequenceRef.current;
          const flushDelayMs = scheduledAtMs == null ? null : getNowMs() - scheduledAtMs;

          if (
            assistantDeltaMutationCount > 0
            && (
              flushSequence === 1
              || assistantDeltaMutationCount >= 8
              || (flushDelayMs != null && flushDelayMs >= 48)
            )
          ) {
            debugLog("thread.stream.performance", "flush.applied", {
              threadId: selectedThreadId,
              flushSequence,
              flushDelayMs,
              pendingEventsCount: pendingEvents.length,
              pendingMutationsCount: pendingMutations.length,
              assistantDeltaMutationCount,
              newestPendingEventIdx: pendingEvents[pendingEvents.length - 1]?.idx ?? null,
            }, { threadId: selectedThreadId, force: true });
          }

          startTransition(() => {
            flushPendingEventsToCollection(selectedThreadId, pendingEvents);
            flushPendingMessageMutationsToCollection(selectedThreadId, pendingMutations);
          });
        });
      }

      if (selectedWorktreeId && GIT_STATUS_INVALIDATION_EVENT_TYPES.has(payload.type)) {
        markWorktreeGitStatusChanged(queryClient, selectedWorktreeId, {
          cause: "thread_activity",
        });
      }

      if (payload.type === "chat.completed" || payload.type === "chat.failed") {
        const completedThreadTitle = payload.type === "chat.completed"
          ? payloadStringOrNull(payload.payload.threadTitle)
          : null;
        if (selectedWorktreeId) {
          onCompletionAttentionEvent?.({
            eventId: payload.id,
            threadId: selectedThreadId,
            worktreeId: selectedWorktreeId,
            type: payload.type,
            threadTitle: completedThreadTitle,
          });
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.threads.timelineSnapshot(selectedThreadId) });
        setThreads((current) => {
          const index = current.findIndex((thread) => thread.id === selectedThreadId);
          if (index === -1 || !current[index]?.active) {
            return current;
          }
          const updated = [...current];
          updated[index] = { ...updated[index]!, active: false };
          return updated;
        });
        if (selectedWorktreeId) {
          queryClient.setQueryData<ChatThread[] | undefined>(
            queryKeys.threads.list(selectedWorktreeId),
            (current) => {
              if (!current) {
                return current;
              }
              const index = current.findIndex((thread) => thread.id === selectedThreadId);
              if (index === -1 || !current[index]?.active) {
                return current;
              }
              const updated = [...current];
              updated[index] = { ...updated[index]!, active: false };
              return updated;
            },
          );
        }
        if (repositoryIdRef.current && selectedThreadIsPrMrRef.current) {
          requestRepositoryReviewsLiveRefresh(queryClient, repositoryIdRef.current);
        }
      }

      if (payload.type === "chat.completed") {
        const completedMessageId = String(payload.payload.messageId ?? "");
        const completedThreadTitle = payloadStringOrNull(payload.payload.threadTitle);
        const completedBranch = payloadStringOrNull(payload.payload.worktreeBranch);
        if (completedMessageId.length > 0) {
          streamingMessageIdsRef.current.delete(completedMessageId);
        }
        if (completedThreadTitle) {
          setThreads((current) => applyThreadTitleUpdate(current, selectedThreadId, completedThreadTitle));
          if (selectedWorktreeId) {
            queryClient.setQueryData<ChatThread[] | undefined>(
              queryKeys.threads.list(selectedWorktreeId),
              (current) => current ? applyThreadTitleUpdate(current, selectedThreadId, completedThreadTitle) : current,
            );
          }
        }
        const completedMode = payloadStringOrNull(payload.payload.threadMode);
        if (completedMode === "default" || completedMode === "plan") {
          setThreads((current) => applyThreadModeUpdate(current, selectedThreadId, completedMode));
          if (selectedWorktreeId) {
            queryClient.setQueryData<ChatThread[] | undefined>(
              queryKeys.threads.list(selectedWorktreeId),
              (current) => current ? applyThreadModeUpdate(current, selectedThreadId, completedMode) : current,
            );
          }
        }
        if (completedBranch && selectedWorktreeId) {
          onBranchRenamed?.(selectedWorktreeId, completedBranch);
        }
      }

      if (payload.type === "tool.finished") {
        const source = payloadStringOrNull(payload.payload.source);
        if (source === "chat.thread.metadata") {
          const metadataThreadTitle = payloadStringOrNull(payload.payload.threadTitle);
          const metadataBranch = payloadStringOrNull(payload.payload.worktreeBranch);
          if (metadataThreadTitle) {
            setThreads((current) => applyThreadTitleUpdate(current, selectedThreadId, metadataThreadTitle));
            if (selectedWorktreeId) {
              queryClient.setQueryData<ChatThread[] | undefined>(
                queryKeys.threads.list(selectedWorktreeId),
                (current) => current ? applyThreadTitleUpdate(current, selectedThreadId, metadataThreadTitle) : current,
              );
            }
          }
          if (metadataBranch && selectedWorktreeId) {
            onBranchRenamed?.(selectedWorktreeId, metadataBranch);
          }
        }
      }
    };

    const MAX_RECONNECT_ATTEMPTS = 5;
    const BASE_RECONNECT_DELAY_MS = 1000;

    const startStream = () => {
      if (disposed) {
        return;
      }

      closeStream();
      updateConnectionState(
        getThreadReconnectAttempts(selectedThreadId) > 0 ? "reconnecting" : "connecting",
        undefined,
        "stream.start",
      );

      const cachedSnapshot = queryClient.getQueryData<ChatTimelineSnapshot>(
        queryKeys.threads.timelineSnapshot(selectedThreadId),
      );
      if (cachedSnapshot) {
        syncThreadStreamCursorFromSnapshot(selectedThreadId, cachedSnapshot);
      }

      const existingEvents = getThreadEventsCollection(selectedThreadId).toArray as ChatEvent[];
      const existingLastEventIdx = existingEvents[existingEvents.length - 1]?.idx ?? null;
      if (existingLastEventIdx != null) {
        setThreadLastEventIdx(selectedThreadId, existingLastEventIdx);
      }

      const streamUrl = new URL(`${api.runtimeBaseUrl}/api/threads/${selectedThreadId}/events/stream`);
      const lastEventIdx = getThreadLastEventIdx(selectedThreadId);
      const localSummary = summarizeLocalThreadCollections(selectedThreadId);
      if (localSummary.eventsCount === 0 && typeof lastEventIdx === "number") {
        debugLog("thread.history", "stream.afterIdx.with-empty-local-events", {
          threadId: selectedThreadId,
          worktreeId: selectedWorktreeId,
          afterIdx: lastEventIdx,
          cachedSnapshotPresent: cachedSnapshot != null,
          cachedSnapshotCollectionsIncluded: cachedSnapshot?.collectionsIncluded ?? null,
          cachedSnapshotEventCount: cachedSnapshot?.events.length ?? null,
          cachedSnapshotMessageCount: cachedSnapshot?.messages.length ?? null,
          local: localSummary,
        }, { threadId: selectedThreadId, worktreeId: selectedWorktreeId, force: true });
      }
      if (typeof lastEventIdx === "number") {
        streamUrl.searchParams.set("afterIdx", String(lastEventIdx));
      }

      stream = new EventSource(streamUrl.toString());
      logLifecycle("stream.connecting", {
        afterIdx: lastEventIdx,
        url: streamUrl.toString(),
      });

      for (const eventType of EVENT_TYPES) {
        stream.addEventListener(eventType, onEvent as EventListener);
      }
      stream.addEventListener("heartbeat", onHeartbeat as EventListener);
      stream.addEventListener("agent.thinking", ((e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (typeof data.active === "boolean") {
            debugLog("thread.thinking", "stream.agent.thinking", {
              threadId: selectedThreadId,
              active: data.active,
            }, { threadId: selectedThreadId, force: true });
            setThreadThinkingActive(selectedThreadId, data.active);
          }
        } catch { /* ignore malformed JSON */ }
      }) as EventListener);

      stream.onopen = () => {
        lastOpenAtMs = getNowMs();
        markStreamActivity();
        resetThreadReconnectAttempts(selectedThreadId);
        clearThreadReconnectTimer(selectedThreadId);
        updateConnectionState("healthy", undefined, "stream.open");
        onError(null);
        logHealth("stream.open", {
          afterIdx: lastEventIdx,
        });
        logLifecycle("stream.open", {
          afterIdx: lastEventIdx,
        });
      };

      stream.onerror = () => {
        if (disposed) {
          return;
        }
        logLifecycle("stream.error", {
          readyState: stream?.readyState ?? null,
          reconnectAttempts: getThreadReconnectAttempts(selectedThreadId),
        });
        logHealth("stream.error");
        if (stream && stream.readyState === EventSource.CLOSED) {
          closeStream();

          if (getThreadReconnectAttempts(selectedThreadId) < MAX_RECONNECT_ATTEMPTS) {
            const attempt = incrementThreadReconnectAttempts(selectedThreadId);
            updateConnectionState("reconnecting", undefined, "stream.error.reconnect-scheduled", {
              attempt,
            });
            const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt - 1);
            logLifecycle("stream.reconnect.scheduled", {
              attempt,
              delayMs: delay,
            });
            const reconnectTimer = setTimeout(() => {
              setThreadReconnectTimer(selectedThreadId, null);
              startStream();
            }, delay);
            setThreadReconnectTimer(selectedThreadId, reconnectTimer);
          } else {
            updateConnectionState("exhausted", "Lost connection to chat stream", "stream.error.exhausted");
            onError("Lost connection to chat stream");
          }
        }
      };
    };

    void (async () => {
      try {
        const bootstrapThreadId = selectedThreadId;
        const cachedSnapshot = queryClient.getQueryData<ChatTimelineSnapshot>(
          queryKeys.threads.timelineSnapshot(bootstrapThreadId),
        );
        if (cachedSnapshot) {
          syncThreadStreamCursorFromSnapshot(bootstrapThreadId, cachedSnapshot);
        }

        const existingEvents = getThreadEventsCollection(bootstrapThreadId).toArray as ChatEvent[];
        const existingLastEventIdx = existingEvents[existingEvents.length - 1]?.idx ?? null;
        if (existingLastEventIdx != null) {
          setThreadLastEventIdx(bootstrapThreadId, existingLastEventIdx);
        }

        if (getThreadLastEventIdx(bootstrapThreadId) == null) {
          const cachedStatusSnapshot = queryClient.getQueryData<ChatThreadStatusSnapshot>(
            queryKeys.threads.statusSnapshot(bootstrapThreadId),
          );

          if (cachedStatusSnapshot) {
            const localBeforeStatusCursor = summarizeLocalThreadCollections(bootstrapThreadId);
            if (localBeforeStatusCursor.eventsCount === 0 && cachedStatusSnapshot.newestIdx != null) {
              debugLog("thread.history", "status-cursor-before-history.cached", {
                threadId: bootstrapThreadId,
                worktreeId: selectedWorktreeId,
                statusNewestIdx: cachedStatusSnapshot.newestIdx,
                status: cachedStatusSnapshot.status,
                cachedSnapshotPresent: cachedSnapshot != null,
                local: localBeforeStatusCursor,
              }, { threadId: bootstrapThreadId, worktreeId: selectedWorktreeId, force: true });
            }
            syncThreadStreamCursorFromStatus(bootstrapThreadId, cachedStatusSnapshot);
          } else {
            const statusSnapshot = await queryClient.fetchQuery({
              queryKey: queryKeys.threads.statusSnapshot(bootstrapThreadId),
              queryFn: () => api.getThreadStatusSnapshot(bootstrapThreadId),
            });
            if (
              disposed
              || locallyDeletedThreadIdsRef.current.has(bootstrapThreadId)
              || activeThreadIdRef.current !== bootstrapThreadId
            ) {
              return;
            }

            const localBeforeStatusCursor = summarizeLocalThreadCollections(bootstrapThreadId);
            if (localBeforeStatusCursor.eventsCount === 0 && statusSnapshot.newestIdx != null) {
              debugLog("thread.history", "status-cursor-before-history.fetched", {
                threadId: bootstrapThreadId,
                worktreeId: selectedWorktreeId,
                statusNewestIdx: statusSnapshot.newestIdx,
                status: statusSnapshot.status,
                cachedSnapshotPresent: cachedSnapshot != null,
                local: localBeforeStatusCursor,
              }, { threadId: bootstrapThreadId, worktreeId: selectedWorktreeId, force: true });
            }
            syncThreadStreamCursorFromStatus(bootstrapThreadId, statusSnapshot);
          }
        }
      } catch {}

      if (!disposed) {
        startStream();
        watchdogTimer = setInterval(() => {
          if (disposed) {
            return;
          }

          const staleForMs = getNowMs() - lastStreamActivityAtMs;
          const selectedThreadStatus = queryClient.getQueryData<ChatThreadStatusSnapshot>(
            queryKeys.threads.statusSnapshot(selectedThreadId),
          );
          const selectedThreadList = selectedWorktreeId
            ? queryClient.getQueryData<ChatThread[]>(queryKeys.threads.list(selectedWorktreeId))
            : undefined;
          const selectedThread = selectedThreadList?.find((thread) => thread.id === selectedThreadId) ?? null;
          const waitingForAssistant = waitingAssistantRef.current?.threadId === selectedThreadId;
          const shouldWatch =
            waitingForAssistant
            || selectedThread?.active === true
            || (selectedThreadStatus?.status != null && selectedThreadStatus.status !== "idle")
            || stream?.readyState === EventSource.CONNECTING;

          if (!shouldWatch || staleForMs < STREAM_STALE_THRESHOLD_MS) {
            return;
          }

          if (getNowMs() - lastResyncAttemptAtMs < STREAM_STALE_THRESHOLD_MS) {
            return;
          }

          updateConnectionState("stale", undefined, "watchdog.stale", {
            staleForMs,
          });
          logHealth("watchdog.stale", {
            staleForMs,
            cachedStatus: selectedThreadStatus?.status ?? null,
            cachedNewestIdx: selectedThreadStatus?.newestIdx ?? null,
            waitingForAssistant,
            threadActive: selectedThread?.active ?? false,
          });
          logWatchdog("stale.detected", {
            staleForMs,
            streamReadyState: stream?.readyState ?? null,
            cachedStatus: selectedThreadStatus?.status ?? null,
            cachedNewestIdx: selectedThreadStatus?.newestIdx ?? null,
            localNewestIdx: getThreadLastEventIdx(selectedThreadId),
            waitingForAssistant,
            threadActive: selectedThread?.active ?? false,
          });
          void resyncFromRemote("stale-watchdog");

          if (
            stream?.readyState === EventSource.CONNECTING
            && staleForMs >= STREAM_CONNECTING_RESTART_THRESHOLD_MS
          ) {
            logWatchdog("stream.restart.connecting", {
              staleForMs,
            });
            streamRestartCount += 1;
            logHealth("stream.restart.connecting", {
              staleForMs,
            });
            closeStream();
            startStream();
          }
        }, STREAM_WATCHDOG_INTERVAL_MS);
      }
    })();

    const handleVisibilityChange = () => {
      if (!isDocumentForegrounded()) {
        return;
      }

      logLifecycle("foreground.visibility", {
        localNewestIdx: getThreadLastEventIdx(selectedThreadId),
        visibilityState: typeof document === "undefined" ? null : document.visibilityState,
        hasFocus: typeof document === "undefined" || typeof document.hasFocus !== "function"
          ? null
          : document.hasFocus(),
      });
      void resyncFromRemote("visibility");
    };

    const handleFocus = () => {
      logLifecycle("foreground.focus", {
        localNewestIdx: getThreadLastEventIdx(selectedThreadId),
      });
      void resyncFromRemote("focus");
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", handleFocus);
    }

    return () => {
      disposed = true;
      markThreadStreamDisposed(selectedThreadId, true);
      flushPendingEventsToCollection(selectedThreadId, pendingEventsRef.current);
      flushPendingMessageMutationsToCollection(selectedThreadId, pendingMessageMutationsRef.current);
      clearPendingStreamBuffers();
      clearThreadReconnectTimer(selectedThreadId);
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
      }
      closeStream();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", handleFocus);
      }
      logLifecycle("stream.cleanup", {
        localNewestIdx: getThreadLastEventIdx(selectedThreadId),
      });
      logHealth("stream.cleanup");
    };
  }, [queryClient, selectedThreadId, selectedWorktreeId]);
}
