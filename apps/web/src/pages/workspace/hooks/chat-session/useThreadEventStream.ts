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
import {
  getThreadCollections,
  getThreadEventsCollection,
  getThreadMessagesCollection,
} from "../../../../collections/threadCollections";
import {
  allocateNextThreadMessageSeq,
  clearThreadReconnectTimer,
  getThreadLastEventIdx,
  getThreadLastMessageSeq,
  getThreadReconnectAttempts,
  hasSeenThreadEvent,
  incrementThreadReconnectAttempts,
  markThreadEventSeen,
  markThreadStreamDisposed,
  replaceSeenThreadEventIds,
  resetThreadReconnectAttempts,
  setThreadLastEventIdx,
  setThreadLastMessageSeq,
  setThreadReconnectTimer,
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

const LIVE_ACTIVITY_EVENT_TYPES = new Set<ChatEvent["type"]>([
  "message.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "permission.requested",
  "question.requested",
  "plan.created",
]);

const STREAM_WATCHDOG_INTERVAL_MS = 2_000;
const STREAM_STALE_THRESHOLD_MS = 7_000;
const STREAM_CONNECTING_RESTART_THRESHOLD_MS = 15_000;

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
}

function syncThreadStreamCursorFromSnapshot(threadId: string, snapshot: ChatTimelineSnapshot) {
  const snapshotNewestIdx = snapshot.newestIdx ?? snapshot.events[snapshot.events.length - 1]?.idx ?? null;
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

function syncThreadStreamCursorFromStatus(threadId: string, snapshot: ChatThreadStatusSnapshot) {
  const snapshotNewestIdx = snapshot.newestIdx ?? null;
  const localNewestIdx = getThreadLastEventIdx(threadId);

  if (
    localNewestIdx != null
    && snapshotNewestIdx != null
    && snapshotNewestIdx < localNewestIdx
  ) {
    return;
  }

  if (snapshotNewestIdx != null) {
    setThreadLastEventIdx(threadId, snapshotNewestIdx);
  }
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
  } = params;

  const queryClient = useQueryClient();
  const repositoryIdRef = useRef(repositoryId);
  const selectedThreadIsPrMrRef = useRef(selectedThreadIsPrMr);
  const pendingEventsRef = useRef<ChatEvent[]>([]);
  const pendingMessageMutationsRef = useRef<PendingMessageMutation[]>([]);
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    repositoryIdRef.current = repositoryId;
    selectedThreadIsPrMrRef.current = selectedThreadIsPrMr;
  }, [repositoryId, selectedThreadIsPrMr]);

  function clearPendingStreamBuffers() {
    pendingEventsRef.current = [];
    pendingMessageMutationsRef.current = [];
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }

  useEffect(() => {
    if (!selectedThreadId) {
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
    let lastResyncAttemptAtMs = 0;

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

    const markStreamActivity = () => {
      lastStreamActivityAtMs = getNowMs();
    };

    const closeStream = () => {
      if (!stream) {
        return;
      }

      for (const eventType of EVENT_TYPES) {
        stream.removeEventListener(eventType, onEvent as EventListener);
      }
      stream.close();
      stream = null;
    };

    const resyncFromRemote = async (reason: string) => {
      if (disposed || resyncInFlight) {
        return;
      }

      resyncInFlight = true;
      lastResyncAttemptAtMs = getNowMs();
      const localNewestIdxBefore = getThreadLastEventIdx(selectedThreadId);
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
        syncThreadStreamCursorFromSnapshot(selectedThreadId, timelineSnapshot);
        markStreamActivity();
        onError(null);
        logWatchdog("timeline.resync.completed", {
          reason,
          snapshotNewestIdx: timelineSnapshot.newestIdx,
          snapshotNewestSeq: timelineSnapshot.newestSeq,
          snapshotEventCount: timelineSnapshot.events.length,
          snapshotMessageCount: timelineSnapshot.messages.length,
        });
      } catch (error) {
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

      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          if (disposed) {
            return;
          }

          const pendingEvents = pendingEventsRef.current;
          const pendingMutations = pendingMessageMutationsRef.current;
          pendingEventsRef.current = [];
          pendingMessageMutationsRef.current = [];

          if (pendingEvents.length === 0 && pendingMutations.length === 0) {
            return;
          }

          startTransition(() => {
            flushPendingEventsToCollection(selectedThreadId, pendingEvents);
            flushPendingMessageMutationsToCollection(selectedThreadId, pendingMutations);
          });
        });
      }

      if (SNAPSHOT_INVALIDATION_EVENT_TYPES.has(payload.type)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.threads.statusSnapshot(selectedThreadId) });
      }

      if (selectedWorktreeId && GIT_STATUS_INVALIDATION_EVENT_TYPES.has(payload.type)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitStatus(selectedWorktreeId) });
      }

      if (payload.type === "chat.completed" || payload.type === "chat.failed") {
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
          void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.reviews(repositoryIdRef.current) });
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

      stream.onopen = () => {
        markStreamActivity();
        resetThreadReconnectAttempts(selectedThreadId);
        clearThreadReconnectTimer(selectedThreadId);
        onError(null);
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
        if (stream && stream.readyState === EventSource.CLOSED) {
          closeStream();

          if (getThreadReconnectAttempts(selectedThreadId) < MAX_RECONNECT_ATTEMPTS) {
            const attempt = incrementThreadReconnectAttempts(selectedThreadId);
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
    };
  }, [queryClient, selectedThreadId, selectedWorktreeId]);
}
