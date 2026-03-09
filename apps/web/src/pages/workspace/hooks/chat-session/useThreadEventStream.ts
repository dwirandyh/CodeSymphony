import {
  startTransition,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ChatEvent,
  ChatMessage,
  ChatThread,
  ChatThreadSnapshot,
} from "@codesymphony/shared-types";
import { api } from "../../../../lib/api";
import { queryKeys } from "../../../../lib/queryKeys";
import { logService } from "../../../../lib/logService";
import { pushRenderDebug } from "../../../../lib/renderDebug";
import { debugLog } from "../../../../lib/debugLog";
import { EVENT_TYPES, INITIAL_EVENTS_PAGE_LIMIT, INITIAL_MESSAGES_PAGE_LIMIT } from "../../constants";
import {
  GIT_STATUS_INVALIDATION_EVENT_TYPES,
  payloadStringOrNull,
  shouldClearWaitingAssistantOnEvent,
} from "../../eventUtils";
import type { PendingMessageMutation } from "./useChatSession.types";
import { insertAllEvents, applyMessageMutations } from "./messageEventMerge";
import { applyThreadTitleUpdate } from "./snapshotSeed";
import { SNAPSHOT_INVALIDATION_EVENT_TYPES } from "../snapshotInvalidationEventTypes";

const ACTIVE_THREAD_SNAPSHOT_INVALIDATION_SKIP_EVENT_TYPES = new Set<ChatEvent["type"]>([
  "permission.requested",
  "question.requested",
  "plan.created",
  "chat.completed",
]);

export interface UseThreadEventStreamParams {
  selectedThreadId: string | null;
  selectedWorktreeId: string | null;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setEvents: Dispatch<SetStateAction<ChatEvent[]>>;
  setThreads: Dispatch<SetStateAction<ChatThread[]>>;
  setWaitingAssistant: Dispatch<SetStateAction<{ threadId: string; afterIdx: number } | null>>;
  setHasMoreOlderMessages: Dispatch<SetStateAction<boolean>>;
  setHasMoreOlderEvents: Dispatch<SetStateAction<boolean>>;
  setLoadingOlderHistory: Dispatch<SetStateAction<boolean>>;
  setStoppingThreadId: Dispatch<SetStateAction<string | null>>;
  setStopRequestedThreadId: Dispatch<SetStateAction<string | null>>;
  seenEventIdsByThreadRef: MutableRefObject<Map<string, Set<string>>>;
  lastEventIdxByThreadRef: MutableRefObject<Map<string, number>>;
  nextBeforeSeqByThreadRef: MutableRefObject<Map<string, number | null>>;
  nextBeforeIdxByThreadRef: MutableRefObject<Map<string, number | null>>;
  streamingMessageIdsRef: MutableRefObject<Set<string>>;
  stickyRawFallbackMessageIdsRef: MutableRefObject<Set<string>>;
  renderDecisionByMessageIdRef: MutableRefObject<Map<string, string>>;
  loggedFirstInsertOrderByMessageIdRef: MutableRefObject<Set<string>>;
  loadingOlderHistoryRef: MutableRefObject<boolean>;
  pendingEventsRef: MutableRefObject<ChatEvent[]>;
  pendingMessageMutationsRef: MutableRefObject<PendingMessageMutation[]>;
  rafIdRef: MutableRefObject<number | null>;
  onError: (msg: string | null) => void;
  onBranchRenamed?: (worktreeId: string, newBranch: string) => void;
}

export function useThreadEventStream(params: UseThreadEventStreamParams) {
  const {
    selectedThreadId,
    selectedWorktreeId,
    setMessages,
    setEvents,
    setThreads,
    setWaitingAssistant,
    setHasMoreOlderMessages,
    setHasMoreOlderEvents,
    setLoadingOlderHistory,
    setStoppingThreadId,
    setStopRequestedThreadId,
    seenEventIdsByThreadRef,
    lastEventIdxByThreadRef,
    nextBeforeSeqByThreadRef,
    nextBeforeIdxByThreadRef,
    streamingMessageIdsRef,
    stickyRawFallbackMessageIdsRef,
    renderDecisionByMessageIdRef,
    loggedFirstInsertOrderByMessageIdRef,
    loadingOlderHistoryRef,
    pendingEventsRef,
    pendingMessageMutationsRef,
    rafIdRef,
    onError,
    onBranchRenamed,
  } = params;

  const queryClient = useQueryClient();

  function ensureSeenEventIds(threadId: string): Set<string> {
    const existing = seenEventIdsByThreadRef.current.get(threadId);
    if (existing) return existing;
    const created = new Set<string>();
    seenEventIdsByThreadRef.current.set(threadId, created);
    return created;
  }

  function updateLastEventIdx(threadId: string, idx: number) {
    const current = lastEventIdxByThreadRef.current.get(threadId);
    if (current == null || idx > current) {
      lastEventIdxByThreadRef.current.set(threadId, idx);
    }
  }

  useEffect(() => {
    if (!selectedThreadId) {
      setWaitingAssistant(null);
      setHasMoreOlderMessages(false);
      setHasMoreOlderEvents(false);
      loadingOlderHistoryRef.current = false;
      setLoadingOlderHistory(false);
      setStoppingThreadId(null);
      setStopRequestedThreadId(null);
      streamingMessageIdsRef.current = new Set();
      stickyRawFallbackMessageIdsRef.current = new Set();
      loggedFirstInsertOrderByMessageIdRef.current = new Set();
      setMessages([]);
      setEvents([]);
      return;
    }

    streamingMessageIdsRef.current = new Set();
    stickyRawFallbackMessageIdsRef.current = new Set();
    renderDecisionByMessageIdRef.current = new Map();
    loggedFirstInsertOrderByMessageIdRef.current = new Set();
    setWaitingAssistant(null);
    setHasMoreOlderMessages(nextBeforeSeqByThreadRef.current.get(selectedThreadId) != null);
    setHasMoreOlderEvents(nextBeforeIdxByThreadRef.current.get(selectedThreadId) != null);
    loadingOlderHistoryRef.current = false;
    setLoadingOlderHistory(false);
    setStoppingThreadId(null);
    setStopRequestedThreadId(null);

    let disposed = false;
    let stream: EventSource | null = null;

    const onEvent = (rawEvent: MessageEvent<string>) => {
      if (disposed) return;

      const payload = JSON.parse(rawEvent.data) as ChatEvent;
      const seenEventIds = ensureSeenEventIds(selectedThreadId);
      if (seenEventIds.has(payload.id)) {
        debugLog("useChatSession", "SSE event SKIPPED (dup)", { type: payload.type, idx: payload.idx });
        return;
      }

      debugLog("useChatSession", "chat.sse.eventAccepted", {
        threadId: selectedThreadId,
        eventId: payload.id,
        idx: payload.idx,
        type: payload.type,
        messageId: typeof payload.payload.messageId === "string" ? payload.payload.messageId : null,
        duringOlderPagination: loadingOlderHistoryRef.current,
      });
      seenEventIds.add(payload.id);
      updateLastEventIdx(selectedThreadId, payload.idx);
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

      setWaitingAssistant((current) => {
        if (!current || current.threadId !== selectedThreadId || payload.idx <= current.afterIdx) return current;
        const shouldClear = shouldClearWaitingAssistantOnEvent(payload);
        debugLog("useChatSession", "waitingAssistant event check", {
          eventType: payload.type,
          eventIdx: payload.idx,
          afterIdx: current.afterIdx,
          selectedThreadId,
          shouldClear,
        });
        if (shouldClear) {
          debugLog("useChatSession", "waitingAssistant cleared by SSE event", {
            eventType: payload.type,
            eventIdx: payload.idx,
            selectedThreadId,
          });
          return null;
        }
        return current;
      });

      pendingEventsRef.current.push(payload);

      if (payload.type === "thinking.delta") {
        const messageId = String(payload.payload.messageId ?? "");
        if (messageId.length > 0) {
          streamingMessageIdsRef.current.add(messageId);
          pendingMessageMutationsRef.current.push({
            kind: "ensure-placeholder",
            id: messageId,
            threadId: selectedThreadId,
          });
        }
      }

      if (payload.type === "message.delta") {
        const messageId = String(payload.payload.messageId ?? "");
        const role =
          payload.payload.role === "assistant" || payload.payload.role === "user"
            ? payload.payload.role
            : "assistant";
        const delta = String(payload.payload.delta ?? "");
        pushRenderDebug({
          source: "WorkspacePage",
          event: "messageDelta",
          messageId,
          details: { role, deltaLength: delta.length, idx: payload.idx },
        });

        if (messageId.length > 0) {
          if (role === "assistant") {
            streamingMessageIdsRef.current.add(messageId);
            debugLog("useChatSession", "streaming message tracked", {
              selectedThreadId,
              messageId,
              reason: "message.delta.assistant",
              trackedCount: streamingMessageIdsRef.current.size,
            });
          }
          pendingMessageMutationsRef.current.push({
            kind: "message-delta",
            id: messageId,
            threadId: selectedThreadId,
            role,
            delta,
          });
        }
      }

      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          const pendingEvents = pendingEventsRef.current;
          const pendingMutations = pendingMessageMutationsRef.current;
          pendingEventsRef.current = [];
          pendingMessageMutationsRef.current = [];

          debugLog("useChatSession", "chat.sse.flush", {
            threadId: selectedThreadId,
            duringOlderPagination: loadingOlderHistoryRef.current,
            pendingEventsCount: pendingEvents.length,
            pendingMutationsCount: pendingMutations.length,
            mutationCount: pendingMutations.length,
            eventTypes: pendingEvents.map((e) => e.type),
            eventIdxRange: pendingEvents.length > 0
              ? {
                min: pendingEvents[0]?.idx ?? null,
                max: pendingEvents[pendingEvents.length - 1]?.idx ?? null,
              }
              : null,
          });

          if (pendingEvents.length > 0 || pendingMutations.length > 0) {
            startTransition(() => {
              if (pendingEvents.length > 0) {
                setEvents((current) => insertAllEvents(current, pendingEvents));
              }
              if (pendingMutations.length > 0) {
                setMessages((current) => applyMessageMutations(current, pendingMutations));
              }
            });
          }
        });
      }

      if (
        payload.type === "permission.requested" ||
        payload.type === "permission.resolved" ||
        payload.type === "question.requested" ||
        payload.type === "question.answered" ||
        payload.type === "question.dismissed" ||
        payload.type === "plan.created" ||
        payload.type === "plan.approved" ||
        payload.type === "plan.revision_requested"
      ) {
        debugLog("useChatSession", "chat.sse.gate-event", {
          threadId: selectedThreadId,
          eventId: payload.id,
          idx: payload.idx,
          type: payload.type,
          requestId: typeof payload.payload.requestId === "string" ? payload.payload.requestId : null,
        });
      }

      if (SNAPSHOT_INVALIDATION_EVENT_TYPES.has(payload.type)) {
        const skipInvalidation = ACTIVE_THREAD_SNAPSHOT_INVALIDATION_SKIP_EVENT_TYPES.has(payload.type);
        const snapshotState = queryClient.getQueryState(queryKeys.threads.snapshot(selectedThreadId));
        const snapshotData = queryClient.getQueryData<ChatThreadSnapshot>(queryKeys.threads.snapshot(selectedThreadId));
        const localEventCount = pendingEventsRef.current.length;
        debugLog("useChatSession", "chat.sse.invalidateSnapshot", {
          threadId: selectedThreadId,
          reason: payload.type,
          eventId: payload.id,
          idx: payload.idx,
          skipped: skipInvalidation,
          localLastEventIdx: lastEventIdxByThreadRef.current.get(selectedThreadId) ?? null,
          localKnownEventIds: seenEventIds.size,
          localPendingEventBufferCount: localEventCount,
          snapshotFetchStatus: snapshotState?.fetchStatus ?? null,
          snapshotStatus: snapshotState?.status ?? null,
          cachedSnapshotNewestIdx: snapshotData?.watermarks.newestIdx ?? null,
          cachedSnapshotEventCount: snapshotData?.events.data.length ?? null,
        });
        if (!skipInvalidation) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.threads.snapshot(selectedThreadId) });
        }
      }

      if (selectedWorktreeId && GIT_STATUS_INVALIDATION_EVENT_TYPES.has(payload.type)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitStatus(selectedWorktreeId) });
      }

      if (payload.type === "chat.completed" || payload.type === "chat.failed") {
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
      }

      if (payload.type === "chat.completed") {
        const completedMessageId = String(payload.payload.messageId ?? "");
        const completedThreadTitle = payloadStringOrNull(payload.payload.threadTitle);
        const completedBranch = payloadStringOrNull(payload.payload.worktreeBranch);
        if (completedMessageId.length > 0) {
          const deleted = streamingMessageIdsRef.current.delete(completedMessageId);
          debugLog("useChatSession", "streaming message untracked", {
            selectedThreadId,
            messageId: completedMessageId,
            reason: "chat.completed",
            deleted,
            trackedCount: streamingMessageIdsRef.current.size,
          });
        }
        if (completedThreadTitle) {
          setThreads((current) => {
            return applyThreadTitleUpdate(current, selectedThreadId, completedThreadTitle);
          });
        }
        if (completedBranch && selectedWorktreeId) {
          onBranchRenamed?.(selectedWorktreeId, completedBranch);
        }
        pushRenderDebug({
          source: "WorkspacePage",
          event: "chatCompleted",
          messageId: completedMessageId,
          details: { idx: payload.idx },
        });
      }

      if (payload.type === "tool.finished") {
        const source = payloadStringOrNull(payload.payload.source);
        if (source === "chat.thread.metadata") {
          const metadataThreadTitle = payloadStringOrNull(payload.payload.threadTitle);
          const metadataBranch = payloadStringOrNull(payload.payload.worktreeBranch);

          if (metadataThreadTitle) {
            setThreads((current) => {
              return applyThreadTitleUpdate(current, selectedThreadId, metadataThreadTitle);
            });
          }

          if (metadataBranch && selectedWorktreeId) {
            onBranchRenamed?.(selectedWorktreeId, metadataBranch);
          }
        }
      }
    };

    const MAX_RECONNECT_ATTEMPTS = 5;
    const BASE_RECONNECT_DELAY_MS = 1000;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const startStream = () => {
      if (disposed) return;

      const cachedSnapshot = queryClient.getQueryData<ChatThreadSnapshot>(
        queryKeys.threads.snapshot(selectedThreadId),
      );
      const cachedEvents = cachedSnapshot?.events;
      debugLog("useChatSession", "chat.sse.startStream", {
        threadId: selectedThreadId,
        cachedEventCount: cachedEvents?.data.length ?? 0,
        cachedNewestIdx: cachedSnapshot?.watermarks.newestIdx ?? null,
        lastEventIdxBeforeSeed: lastEventIdxByThreadRef.current.get(selectedThreadId) ?? null,
      });
      if (cachedEvents && cachedEvents.data.length > 0) {
        const seenEventIds = ensureSeenEventIds(selectedThreadId);
        for (const e of cachedEvents.data) {
          seenEventIds.add(e.id);
          updateLastEventIdx(selectedThreadId, e.idx);
        }
      }

      const streamUrl = new URL(`${api.runtimeBaseUrl}/api/threads/${selectedThreadId}/events/stream`);
      const lastEventIdx = lastEventIdxByThreadRef.current.get(selectedThreadId);
      if (typeof lastEventIdx === "number") {
        streamUrl.searchParams.set("afterIdx", String(lastEventIdx));
      }

      stream = new EventSource(streamUrl.toString());

      for (const eventType of EVENT_TYPES) {
        stream.addEventListener(eventType, onEvent as EventListener);
      }

      stream.onopen = () => {
        reconnectAttempts = 0;
        debugLog("useChatSession", "chat.sse.connected", {
          threadId: selectedThreadId,
          afterIdx: typeof lastEventIdx === "number" ? lastEventIdx : null,
        });
        onError(null);
      };

      stream.onerror = () => {
        if (disposed) return;
        if (stream && stream.readyState === EventSource.CLOSED) {
          for (const eventType of EVENT_TYPES) {
            stream.removeEventListener(eventType, onEvent as EventListener);
          }
          stream.close();
          stream = null;

          if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts);
            reconnectAttempts++;
            debugLog("useChatSession", "chat.sse.reconnect", {
              threadId: selectedThreadId,
              reconnectAttempts,
              delay,
              afterIdx: lastEventIdxByThreadRef.current.get(selectedThreadId) ?? null,
            });
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              startStream();
            }, delay);
          } else {
            onError("Lost connection to chat stream");
          }
        }
      };
    };

    const cachedSnapshot = queryClient.getQueryData<ChatThreadSnapshot>(
      queryKeys.threads.snapshot(selectedThreadId),
    );

    if (cachedSnapshot) {
      startStream();
      return () => {
        disposed = true;
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        pendingEventsRef.current = [];
        pendingMessageMutationsRef.current = [];
        if (stream) {
          for (const eventType of EVENT_TYPES) {
            stream.removeEventListener(eventType, onEvent as EventListener);
          }
          stream.close();
        }
      };
    }

    void (async () => {
      try {
        debugLog("useChatSession", "chat.sse.prefetchSnapshot:start", {
          threadId: selectedThreadId,
        });
        const snapshot = await queryClient.fetchQuery({
          queryKey: queryKeys.threads.snapshot(selectedThreadId),
          queryFn: () => api.getThreadSnapshot(selectedThreadId, {
            messageLimit: INITIAL_MESSAGES_PAGE_LIMIT,
            eventLimit: INITIAL_EVENTS_PAGE_LIMIT,
          }),
        });
        if (disposed) return;
        debugLog("useChatSession", "chat.sse.prefetchSnapshot:success", {
          threadId: selectedThreadId,
          messagesCount: snapshot.messages.data.length,
          eventsCount: snapshot.events.data.length,
          newestIdx: snapshot.watermarks.newestIdx ?? null,
        });
        const snapshotEvents = snapshot.events;
        if (snapshotEvents.data.length > 0) {
          const seenEventIds = ensureSeenEventIds(selectedThreadId);
          for (const e of snapshotEvents.data) {
            seenEventIds.add(e.id);
            updateLastEventIdx(selectedThreadId, e.idx);
          }
        }
      } catch (error) {
        debugLog("useChatSession", "chat.sse.prefetchSnapshot:error", {
          threadId: selectedThreadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!disposed) startStream();
    })();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      pendingEventsRef.current = [];
      pendingMessageMutationsRef.current = [];
      if (stream) {
        for (const eventType of EVENT_TYPES) {
          stream.removeEventListener(eventType, onEvent as EventListener);
        }
        stream.close();
      }
    };
  }, [selectedThreadId]);
}
