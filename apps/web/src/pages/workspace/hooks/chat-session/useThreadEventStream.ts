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
  ChatTimelineSnapshot,
} from "@codesymphony/shared-types";
import { api } from "../../../../lib/api";
import { queryKeys } from "../../../../lib/queryKeys";
import { logService } from "../../../../lib/logService";
import { pushRenderDebug } from "../../../../lib/renderDebug";
import { EVENT_TYPES } from "../../constants";
import {
  GIT_STATUS_INVALIDATION_EVENT_TYPES,
  isMetadataToolEvent,
  payloadStringOrNull,
  shouldClearWaitingAssistantOnEvent,
} from "../../eventUtils";
import type { PendingMessageMutation } from "./useChatSession.types";
import { insertAllEvents, applyMessageMutations } from "./messageEventMerge";
import { applyThreadModeUpdate, applyThreadTitleUpdate } from "./snapshotSeed";
import { SNAPSHOT_INVALIDATION_EVENT_TYPES } from "../snapshotInvalidationEventTypes";

const ACTIVE_THREAD_SNAPSHOT_INVALIDATION_SKIP_EVENT_TYPES = new Set<ChatEvent["type"]>([
  "permission.requested",
  "question.requested",
  "plan.created",
]);

const LIVE_ACTIVITY_EVENT_TYPES = new Set<ChatEvent["type"]>([
  "message.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "permission.requested",
  "question.requested",
  "plan.created",
]);

function isLiveActivityEvent(event: ChatEvent): boolean {
  return LIVE_ACTIVITY_EVENT_TYPES.has(event.type) && !isMetadataToolEvent(event);
}

interface UseThreadEventStreamParams {
  selectedThreadId: string | null;
  selectedWorktreeId: string | null;
  repositoryId: string | null;
  selectedThreadIsPrMr: boolean;
  locallyDeletedThreadIdsRef: MutableRefObject<Set<string>>;
  activeThreadIdRef: MutableRefObject<string | null>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setEvents: Dispatch<SetStateAction<ChatEvent[]>>;
  setThreads: Dispatch<SetStateAction<ChatThread[]>>;
  setWaitingAssistant: Dispatch<SetStateAction<{ threadId: string; afterIdx: number } | null>>;
  setStoppingThreadId: Dispatch<SetStateAction<string | null>>;
  setStopRequestedThreadId: Dispatch<SetStateAction<string | null>>;
  seenEventIdsByThreadRef: MutableRefObject<Map<string, Set<string>>>;
  lastEventIdxByThreadRef: MutableRefObject<Map<string, number>>;
  streamingMessageIdsRef: MutableRefObject<Set<string>>;
  stickyRawFallbackMessageIdsRef: MutableRefObject<Set<string>>;
  renderDecisionByMessageIdRef: MutableRefObject<Map<string, string>>;
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
    repositoryId,
    selectedThreadIsPrMr,
    locallyDeletedThreadIdsRef,
    activeThreadIdRef,
    setMessages,
    setEvents,
    setThreads,
    setWaitingAssistant,
    setStoppingThreadId,
    setStopRequestedThreadId,
    seenEventIdsByThreadRef,
    lastEventIdxByThreadRef,
    streamingMessageIdsRef,
    stickyRawFallbackMessageIdsRef,
    renderDecisionByMessageIdRef,
    pendingEventsRef,
    pendingMessageMutationsRef,
    rafIdRef,
    onError,
    onBranchRenamed,
  } = params;

  const queryClient = useQueryClient();
  const repositoryIdRef = useRef(repositoryId);
  const selectedThreadIsPrMrRef = useRef(selectedThreadIsPrMr);

  useEffect(() => {
    repositoryIdRef.current = repositoryId;
    selectedThreadIsPrMrRef.current = selectedThreadIsPrMr;
  }, [repositoryId, selectedThreadIsPrMr]);

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
      setMessages((current) => (current.length === 0 ? current : []));
      setEvents((current) => (current.length === 0 ? current : []));
      return;
    }

    clearPendingStreamBuffers();
    streamingMessageIdsRef.current = new Set();
    stickyRawFallbackMessageIdsRef.current = new Set();
    renderDecisionByMessageIdRef.current = new Map();
    setStoppingThreadId(null);
    setStopRequestedThreadId(null);

    let disposed = false;
    let stream: EventSource | null = null;

    const onEvent = (rawEvent: MessageEvent<string>) => {
      if (disposed) return;

      const payload = JSON.parse(rawEvent.data) as ChatEvent;
      const seenEventIds = ensureSeenEventIds(selectedThreadId);
      if (seenEventIds.has(payload.id)) {
        return;
      }

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
        if (!current || current.threadId !== selectedThreadId || payload.idx <= current.afterIdx) return current;
        const shouldClear = shouldClearWaitingAssistantOnEvent(payload);
        if (shouldClear) {
          return null;
        }
        return current;
      });

      pendingEventsRef.current.push(payload);

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
          const pendingEvents = pendingEventsRef.current;
          const pendingMutations = pendingMessageMutationsRef.current;
          pendingEventsRef.current = [];
          pendingMessageMutationsRef.current = [];

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

      if (SNAPSHOT_INVALIDATION_EVENT_TYPES.has(payload.type)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.threads.statusSnapshot(selectedThreadId) });
        const skipInvalidation = ACTIVE_THREAD_SNAPSHOT_INVALIDATION_SKIP_EVENT_TYPES.has(payload.type);
        if (!skipInvalidation) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.threads.timelineSnapshot(selectedThreadId) });
        }
      }

      if (selectedWorktreeId && GIT_STATUS_INVALIDATION_EVENT_TYPES.has(payload.type)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitStatus(selectedWorktreeId) });
      }

      if (payload.type === "chat.completed" || payload.type === "chat.failed") {
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
              if (!current) return current;
              const index = current.findIndex((thread) => thread.id === selectedThreadId);
              if (index === -1 || !current[index]?.active) return current;
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
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const startStream = () => {
      if (disposed) return;

      const cachedSnapshot = queryClient.getQueryData<ChatTimelineSnapshot>(
        queryKeys.threads.timelineSnapshot(selectedThreadId),
      );
      if (cachedSnapshot && cachedSnapshot.events.length > 0) {
        const seenEventIds = ensureSeenEventIds(selectedThreadId);
        for (const e of cachedSnapshot.events) {
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

    const cachedSnapshot = queryClient.getQueryData<ChatTimelineSnapshot>(
      queryKeys.threads.timelineSnapshot(selectedThreadId),
    );

    startStream();

    if (!cachedSnapshot) {
      void (async () => {
        try {
          const bootstrapThreadId = selectedThreadId;
          const snapshot = await queryClient.fetchQuery({
            queryKey: queryKeys.threads.timelineSnapshot(bootstrapThreadId),
            queryFn: () => api.getTimelineSnapshot(bootstrapThreadId),
          });
          if (
            disposed
            || locallyDeletedThreadIdsRef.current.has(bootstrapThreadId)
            || activeThreadIdRef.current !== bootstrapThreadId
          ) return;
          if (snapshot.events.length > 0) {
            const seenEventIds = ensureSeenEventIds(bootstrapThreadId);
            for (const e of snapshot.events) {
              seenEventIds.add(e.id);
              updateLastEventIdx(bootstrapThreadId, e.idx);
            }
          }
        } catch {}
      })();
    }

    return () => {
      disposed = true;
      clearPendingStreamBuffers();
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
  }, [queryClient, selectedThreadId, selectedWorktreeId]);
}
