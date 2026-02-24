import { startTransition, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatEvent, ChatMessage, ChatMode, ChatThread, AttachmentInput } from "@codesymphony/shared-types";
import type { PendingAttachment } from "../../../lib/attachments";
import { isImageMimeType } from "../../../lib/attachments";
import { api } from "../../../lib/api";
import { queryKeys } from "../../../lib/queryKeys";
import { logService } from "../../../lib/logService";
import { pushRenderDebug } from "../../../lib/renderDebug";
import { debugLog } from "../../../lib/debugLog";
import { useThreads } from "../../../hooks/queries/useThreads";
import { useThreadMessages } from "../../../hooks/queries/useThreadMessages";
import { useThreadEvents } from "../../../hooks/queries/useThreadEvents";
import { EVENT_TYPES } from "../constants";
import { payloadStringOrNull, shouldClearWaitingAssistantOnEvent } from "../eventUtils";
import { useWorkspaceTimeline, type TimelineRefs } from "./useWorkspaceTimeline";

type PendingMessageMutation =
  | { kind: "ensure-placeholder"; id: string; threadId: string }
  | { kind: "message-delta"; id: string; threadId: string; role: "assistant" | "user"; delta: string };

function insertAllEvents(current: ChatEvent[], incoming: ChatEvent[]): ChatEvent[] {
  if (incoming.length === 0) return current;
  if (current.length === 0) {
    return incoming.length > 1 ? [...incoming].sort((a, b) => a.idx - b.idx) : [...incoming];
  }
  const lastIdx = current[current.length - 1].idx;
  if (incoming.every(e => e.idx > lastIdx)) {
    const sorted = incoming.length > 1 ? [...incoming].sort((a, b) => a.idx - b.idx) : incoming;
    return [...current, ...sorted];
  }
  return [...current, ...incoming].sort((a, b) => a.idx - b.idx);
}

function applyMessageMutations(
  current: ChatMessage[],
  mutations: PendingMessageMutation[],
): ChatMessage[] {
  if (mutations.length === 0) return current;
  const knownIds = new Set<string>();
  for (const m of current) knownIds.add(m.id);
  const toCreate: ChatMessage[] = [];
  const appendedDeltas = new Map<string, string>();

  for (const mut of mutations) {
    if (mut.kind === "ensure-placeholder") {
      if (!knownIds.has(mut.id)) {
        knownIds.add(mut.id);
        toCreate.push({
          id: mut.id,
          threadId: mut.threadId,
          seq: current.length + toCreate.length,
          role: "assistant" as const,
          content: "",
          attachments: [],
          createdAt: new Date().toISOString(),
        });
      }
    } else {
      if (!knownIds.has(mut.id)) {
        knownIds.add(mut.id);
        toCreate.push({
          id: mut.id,
          threadId: mut.threadId,
          seq: current.length + toCreate.length,
          role: mut.role,
          content: mut.delta,
          attachments: [],
          createdAt: new Date().toISOString(),
        });
      } else if (mut.role !== "user") {
        appendedDeltas.set(mut.id, (appendedDeltas.get(mut.id) ?? "") + mut.delta);
      }
    }
  }

  if (toCreate.length === 0 && appendedDeltas.size === 0) return current;

  let result = toCreate.length > 0 ? [...current, ...toCreate] : current;

  if (appendedDeltas.size > 0) {
    result = result.map(m => {
      const delta = appendedDeltas.get(m.id);
      if (delta != null) return { ...m, content: m.content + delta };
      return m;
    });
  }

  return result;
}

interface UseChatSessionOptions {
  initialThreadId?: string;
  onThreadChange?: (threadId: string | null) => void;
}

export function useChatSession(
  selectedWorktreeId: string | null,
  onError: (msg: string | null) => void,
  onBranchRenamed?: (worktreeId: string, newBranch: string) => void,
  options?: UseChatSessionOptions,
) {
  const queryClient = useQueryClient();
  const renderCountRef = useRef(0);
  renderCountRef.current++;
  debugLog("useChatSession", "render", { renderCount: renderCountRef.current, selectedWorktreeId });

  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<ChatEvent[]>([]);

  const [chatInput, setChatInput] = useState("");
  const [chatMode, setChatMode] = useState<ChatMode>("default");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);

  const [sendingMessage, setSendingMessage] = useState(false);
  const [stoppingThreadId, setStoppingThreadId] = useState<string | null>(null);
  const [stopRequestedThreadId, setStopRequestedThreadId] = useState<string | null>(null);
  const [closingThreadId, setClosingThreadId] = useState<string | null>(null);
  const [waitingAssistant, setWaitingAssistant] = useState<{ threadId: string; afterIdx: number } | null>(null);

  const seenEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const lastEventIdxByThreadRef = useRef<Map<string, number>>(new Map());
  const streamingMessageIdsRef = useRef<Set<string>>(new Set());
  const stickyRawFallbackMessageIdsRef = useRef<Set<string>>(new Set());
  const renderDecisionByMessageIdRef = useRef<Map<string, string>>(new Map());
  const loggedOrphanEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const activeThreadIdRef = useRef<string | null>(null);
  const initialThreadAppliedRef = useRef(false);
  const creatingThreadRef = useRef(false);
  const prevThreadIdRef = useRef<string | null>(null);
  const prevSeedThreadRef = useRef<string | null>(null);
  const prevSeedEventsThreadRef = useRef<string | null>(null);
  const restoredActiveThreadIdsRef = useRef<Set<string>>(new Set());
  const pendingEventsRef = useRef<ChatEvent[]>([]);
  const pendingMessageMutationsRef = useRef<PendingMessageMutation[]>([]);
  const rafIdRef = useRef<number | null>(null);

  // Keep activeThreadIdRef in sync during render so seed effects see the correct
  // value immediately (they run before the SSE effect in React's execution order).
  activeThreadIdRef.current = selectedThreadId;

  // ── TanStack Query: thread listing ──
  const { data: queriedThreads } = useThreads(selectedWorktreeId);
  const prevQueriedThreadsRef = useRef(queriedThreads);
  if (prevQueriedThreadsRef.current !== queriedThreads) {
    debugLog("useChatSession", "queriedThreads ref changed", {
      prevLength: prevQueriedThreadsRef.current?.length ?? null,
      newLength: queriedThreads?.length ?? null,
      same: prevQueriedThreadsRef.current === queriedThreads,
    });
    prevQueriedThreadsRef.current = queriedThreads;
  }

  // ── Consolidated thread sync: single source of truth from TanStack Query ──
  const prevWorktreeIdRef2 = useRef<string | null>(selectedWorktreeId);

  useEffect(() => {
    const worktreeChanged = selectedWorktreeId !== prevWorktreeIdRef2.current;

    debugLog("useChatSession", "consolidated thread-sync", {
      selectedWorktreeId,
      worktreeChanged,
      queriedThreadsLength: queriedThreads?.length ?? null,
      selectedThreadId,
      initialThreadApplied: initialThreadAppliedRef.current,
    });

    // Worktree cleared → reset everything
    if (!selectedWorktreeId) {
      prevWorktreeIdRef2.current = selectedWorktreeId;
      setWaitingAssistant(null);
      setThreads([]);
      setSelectedThreadId(null);
      setMessages([]);
      setEvents([]);
      return;
    }

    // Worktree changed → reset transient state
    if (worktreeChanged) {
      setWaitingAssistant(null);
      setMessages([]);
      setEvents([]);
    }

    // Still loading from TanStack Query → wait
    if (!queriedThreads) return;

    // Mark worktree change as processed only after threads are available
    prevWorktreeIdRef2.current = selectedWorktreeId;

    // Sync threads list — only update if threads actually differ
    setThreads((current) => {
      if (current.length === queriedThreads.length && current.every((t, i) => t.id === queriedThreads[i].id && t.title === queriedThreads[i].title && t.claudeSessionId === queriedThreads[i].claudeSessionId && t.active === queriedThreads[i].active && t.updatedAt === queriedThreads[i].updatedAt)) {
        return current;
      }
      return queriedThreads;
    });

    if (queriedThreads.length > 0) {
      if (worktreeChanged || selectedThreadId == null) {
        // Apply initialThreadId on first load
        if (!initialThreadAppliedRef.current && options?.initialThreadId) {
          initialThreadAppliedRef.current = true;
          const match = queriedThreads.find((t) => t.id === options.initialThreadId);
          setSelectedThreadId(match ? match.id : queriedThreads[0].id);
        } else {
          setSelectedThreadId((current) => {
            // Keep current selection if it still exists in the new threads list
            if (current && queriedThreads.some((t) => t.id === current)) return current;
            return queriedThreads[0].id;
          });
        }
      }
    } else {
      // No threads → auto-create one
      if (!initialThreadAppliedRef.current) {
        initialThreadAppliedRef.current = true;
      }
      if (creatingThreadRef.current) return;
      let cancelled = false;
      creatingThreadRef.current = true;
      void (async () => {
        try {
          const created = await api.createThread(selectedWorktreeId, { title: "Main Thread" });
          if (cancelled) return;
          setThreads([created]);
          setSelectedThreadId(created.id);
          void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(selectedWorktreeId) });
        } catch (e) {
          if (!cancelled) onError(e instanceof Error ? e.message : "Failed to load threads");
        } finally {
          creatingThreadRef.current = false;
        }
      })();
      return () => { cancelled = true; };
    }
  }, [selectedWorktreeId, queriedThreads]);

  // ── Restore running state for threads that are still active on the server ──
  // This handles page refresh while the assistant is processing: the runtime
  // reports `active: true` on the thread, so we restore the waiting UI.
  useEffect(() => {
    if (!selectedThreadId) return;
    if (restoredActiveThreadIdsRef.current.has(selectedThreadId)) return;

    const thread = threads.find((t) => t.id === selectedThreadId);
    if (thread?.active) {
      restoredActiveThreadIdsRef.current.add(selectedThreadId);
      startWaitingAssistant(selectedThreadId);
    }
  }, [selectedThreadId, threads]);

  // ── TanStack Query: thread messages & events (initial seed) ──
  const { data: queriedMessages } = useThreadMessages(selectedThreadId);
  const { data: queriedEvents } = useThreadEvents(selectedThreadId);
  const prevQueriedMessagesRef = useRef(queriedMessages);
  const prevQueriedEventsRef = useRef(queriedEvents);
  if (prevQueriedMessagesRef.current !== queriedMessages) {
    debugLog("useChatSession", "queriedMessages ref changed", {
      prevLength: prevQueriedMessagesRef.current?.length ?? null,
      newLength: queriedMessages?.length ?? null,
    });
    prevQueriedMessagesRef.current = queriedMessages;
  }
  if (prevQueriedEventsRef.current !== queriedEvents) {
    debugLog("useChatSession", "queriedEvents ref changed", {
      prevLength: prevQueriedEventsRef.current?.length ?? null,
      newLength: queriedEvents?.length ?? null,
    });
    prevQueriedEventsRef.current = queriedEvents;
  }

  // Seed local messages from query, merging with any SSE-delivered data
  useEffect(() => {
    const threadChanged = prevSeedThreadRef.current !== selectedThreadId;
    debugLog("useChatSession", "seed messages effect", {
      queriedMessagesLength: queriedMessages?.length ?? null,
      selectedThreadId,
      threadChanged,
    });

    if (threadChanged) {
      prevSeedThreadRef.current = selectedThreadId;
      if (!queriedMessages) {
        // Thread changed but data not yet loaded → clear old thread's data
        setMessages([]);
        return;
      }
      // Thread changed with cached data → full replace (don't merge old thread's messages)
      setMessages([...queriedMessages].sort((a, b) => a.seq - b.seq));
      return;
    }

    // Same thread → merge with SSE-delivered data
    if (!queriedMessages) return;
    setMessages((current) => {
      const merged = new Map<string, ChatMessage>();
      for (const m of queriedMessages) merged.set(m.id, m);
      for (const m of current) {
        const existing = merged.get(m.id);
        if (existing && m.content.length > existing.content.length) {
          merged.set(m.id, m);
        } else if (!existing) {
          merged.set(m.id, m);
        }
      }
      const sorted = [...merged.values()].sort((a, b) => a.seq - b.seq);
      if (sorted.length === current.length && sorted.every((m, i) => m.id === current[i].id && m.content.length === current[i].content.length)) {
        return current;
      }
      return sorted;
    });
  }, [queriedMessages, selectedThreadId]);

  // Seed local events from query, merging with SSE-delivered data
  useEffect(() => {
    const threadChanged = prevSeedEventsThreadRef.current !== selectedThreadId;
    debugLog("useChatSession", "seed events effect", {
      queriedEventsLength: queriedEvents?.length ?? null,
      selectedThreadId,
      threadChanged,
    });

    if (threadChanged) {
      prevSeedEventsThreadRef.current = selectedThreadId;
      if (!queriedEvents) {
        // Thread changed but data not yet loaded → clear old thread's events
        setEvents([]);
        return;
      }
      // Thread changed with cached data → full replace
      setEvents([...queriedEvents].sort((a, b) => a.idx - b.idx));
    } else {
      // Same thread → merge with SSE-delivered data
      if (!queriedEvents) return;
      setEvents((current) => {
        // Fast-path: if local state already covers all queried events, skip the
        // merge entirely. This prevents producing a new array reference when
        // the only difference is object identity (SSE-delivered vs API-returned),
        // which would otherwise cause an infinite render loop on large threads.
        if (current.length > 0 && queriedEvents.length > 0) {
          const currentLastIdx = current[current.length - 1].idx;
          const queriedLastIdx = queriedEvents[queriedEvents.length - 1].idx;
          if (current.length >= queriedEvents.length && currentLastIdx >= queriedLastIdx) {
            return current; // no-op — local state is ahead or equal
          }
        }

        const seen = new Set<string>();
        const merged: ChatEvent[] = [];
        for (const e of queriedEvents) { seen.add(e.id); merged.push(e); }
        for (const e of current) { if (!seen.has(e.id)) merged.push(e); }
        const sorted = merged.sort((a, b) => a.idx - b.idx);
        if (sorted.length === current.length && sorted.every((e, i) => e.id === current[i].id && e.idx === current[i].idx)) {
          return current;
        }
        return sorted;
      });
    }

    // Update tracking refs (runs for both thread-change and same-thread cases)
    if (!queriedEvents) return;
    const seenEventIds = new Set<string>();
    let lastIdx: number | null = null;
    let latestThreadTitle: string | null = null;
    let latestWorktreeBranch: string | null = null;
    for (const event of queriedEvents) {
      seenEventIds.add(event.id);
      if (lastIdx == null || event.idx > lastIdx) lastIdx = event.idx;
      if (event.type === "chat.completed") {
        const title = payloadStringOrNull(event.payload.threadTitle);
        if (title) latestThreadTitle = title;
        const branch = payloadStringOrNull(event.payload.worktreeBranch);
        if (branch) latestWorktreeBranch = branch;
      }
    }

    if (latestThreadTitle) {
      setThreads((current) => {
        const target = current.find((t) => t.id === selectedThreadId);
        if (target && target.title === latestThreadTitle) return current;
        return current.map((t) =>
          t.id === selectedThreadId ? { ...t, title: latestThreadTitle } : t,
        );
      });
    }

    if (latestWorktreeBranch && selectedWorktreeId) {
      onBranchRenamed?.(selectedWorktreeId, latestWorktreeBranch);
    }

    seenEventIdsByThreadRef.current.set(selectedThreadId!, seenEventIds);
    if (lastIdx == null) {
      lastEventIdxByThreadRef.current.delete(selectedThreadId!);
    } else {
      lastEventIdxByThreadRef.current.set(selectedThreadId!, lastIdx);
    }
  }, [queriedEvents, selectedThreadId]);

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

  function startWaitingAssistant(threadId: string) {
    const afterIdx = lastEventIdxByThreadRef.current.get(threadId) ?? -1;
    setWaitingAssistant({ threadId, afterIdx });
  }

  function clearWaitingAssistantForThread(threadId: string) {
    setWaitingAssistant((current) => (current?.threadId === threadId ? null : current));
  }

  // ── Worktree change handling is now consolidated in the effect above ──

  // Notify parent when selected thread changes
  useEffect(() => {
    const willNotify = prevThreadIdRef.current !== selectedThreadId;
    debugLog("useChatSession", "thread-change notification", {
      prevThreadId: prevThreadIdRef.current,
      selectedThreadId,
      willNotify,
    });
    if (willNotify) {
      prevThreadIdRef.current = selectedThreadId;
      options?.onThreadChange?.(selectedThreadId);
    }
  }, [selectedThreadId]);

  // ── Thread change → start SSE stream ──

  useEffect(() => {
    if (!selectedThreadId) {
      setWaitingAssistant(null);
      setStoppingThreadId(null);
      setStopRequestedThreadId(null);
      streamingMessageIdsRef.current = new Set();
      stickyRawFallbackMessageIdsRef.current = new Set();
      setMessages([]);
      setEvents([]);
      return;
    }

    streamingMessageIdsRef.current = new Set();
    stickyRawFallbackMessageIdsRef.current = new Set();
    renderDecisionByMessageIdRef.current = new Map();
    setWaitingAssistant(null);
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

      debugLog("useChatSession", "SSE event ACCEPTED", { type: payload.type, idx: payload.idx });
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
        });
      }

      setWaitingAssistant((current) => {
        if (!current || current.threadId !== selectedThreadId || payload.idx <= current.afterIdx) return current;
        if (shouldClearWaitingAssistantOnEvent(payload)) return null;
        return current;
      });

      // Buffer event for batched state update
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
          if (role === "assistant") streamingMessageIdsRef.current.add(messageId);
          pendingMessageMutationsRef.current.push({
            kind: "message-delta",
            id: messageId,
            threadId: selectedThreadId,
            role,
            delta,
          });
        }
      }

      // Schedule batched flush via requestAnimationFrame
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          const pendingEvents = pendingEventsRef.current;
          const pendingMutations = pendingMessageMutationsRef.current;
          pendingEventsRef.current = [];
          pendingMessageMutationsRef.current = [];

          debugLog("useChatSession", "rAF flush", {
            pendingEventsCount: pendingEvents.length,
            pendingMutationsCount: pendingMutations.length,
            eventTypes: pendingEvents.map((e) => e.type),
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

      if (payload.type === "chat.completed") {
        const completedMessageId = String(payload.payload.messageId ?? "");
        const completedThreadTitle = payloadStringOrNull(payload.payload.threadTitle);
        const completedBranch = payloadStringOrNull(payload.payload.worktreeBranch);
        if (completedMessageId.length > 0) streamingMessageIdsRef.current.delete(completedMessageId);
        if (completedThreadTitle) {
          setThreads((current) => {
            const target = current.find((t) => t.id === selectedThreadId);
            if (target && target.title === completedThreadTitle) return current;
            return current.map((t) =>
              t.id === selectedThreadId ? { ...t, title: completedThreadTitle } : t,
            );
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
        // Invalidate messages query to re-seed fresh data.
        // NOTE: Do NOT invalidate events here — local state is already fully
        // up-to-date from SSE. Re-fetching events triggers a merge that
        // produces a new array reference on every cycle, causing an infinite
        // render loop ("Maximum update depth exceeded") on large threads.
        void queryClient.invalidateQueries({ queryKey: queryKeys.threads.messages(selectedThreadId) });
      }
    };

    // Wait a tick for query data to seed, then start SSE
    const MAX_RECONNECT_ATTEMPTS = 5;
    const BASE_RECONNECT_DELAY_MS = 1000;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const startStream = () => {
      if (disposed) return;

      // Pre-seed seenEventIds and lastEventIdx from query cache so the SSE
      // stream doesn't replay events we already have.
      const cachedEvents = queryClient.getQueryData<ChatEvent[]>(
        queryKeys.threads.events(selectedThreadId),
      );
      if (cachedEvents && cachedEvents.length > 0) {
        const seenEventIds = ensureSeenEventIds(selectedThreadId);
        for (const e of cachedEvents) {
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
          // Close the dead stream
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

    // Wait for events query to complete, then pre-seed dedup state and start SSE
    void (async () => {
      try {
        const cachedEvents = await queryClient.fetchQuery({
          queryKey: queryKeys.threads.events(selectedThreadId),
          queryFn: () => api.listEvents(selectedThreadId),
        });
        if (disposed) return;
        if (cachedEvents && cachedEvents.length > 0) {
          const seenEventIds = ensureSeenEventIds(selectedThreadId);
          for (const e of cachedEvents) {
            seenEventIds.add(e.id);
            updateLastEventIdx(selectedThreadId, e.idx);
          }
        }
      } catch {
        // Start stream without pre-seeding if fetch fails
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

  // ── Clear waiting assistant when events arrive ──

  useEffect(() => {
    if (!selectedThreadId) return;

    setWaitingAssistant((current) => {
      if (!current || current.threadId !== selectedThreadId) return current;
      const shouldClear = events.some(
        (event) => event.idx > current.afterIdx && shouldClearWaitingAssistantOnEvent(event),
      );
      return shouldClear ? null : current;
    });
  }, [events, selectedThreadId]);

  // ── Thread CRUD ──

  async function createAdditionalThread() {
    if (!selectedWorktreeId) return;
    onError(null);

    try {
      const created = await api.createThread(selectedWorktreeId, {
        title: `Thread ${threads.length + 1}`,
      });
      setThreads((current) => {
        if (current.some((t) => t.id === created.id)) return current;
        return [...current, created];
      });
      setSelectedThreadId(created.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(selectedWorktreeId) });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create thread");
    }
  }

  async function createThreadAndSendMessage(title: string, content: string) {
    if (!selectedWorktreeId) return;
    onError(null);

    try {
      const created = await api.createThread(selectedWorktreeId, { title });
      setThreads((current) => {
        if (current.some((t) => t.id === created.id)) return current;
        return [...current, created];
      });
      setSelectedThreadId(created.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(selectedWorktreeId) });
      startWaitingAssistant(created.id);
      setSendingMessage(true);
      try {
        await api.sendMessage(created.id, { content, mode: chatMode, attachments: [] });
        setChatInput("");
      } catch (e) {
        setWaitingAssistant(null);
        throw e;
      } finally {
        setSendingMessage(false);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create review thread");
    }
  }

  async function closeThread(threadId: string) {
    onError(null);
    setClosingThreadId(threadId);

    try {
      await api.deleteThread(threadId);
      setThreads((current) => {
        const updated = current.filter((t) => t.id !== threadId);
        if (selectedThreadId === threadId) {
          const nextThreadId = updated[0]?.id ?? null;
          setWaitingAssistant(null);
          setSelectedThreadId(nextThreadId);
          if (!nextThreadId) {
            setMessages([]);
            setEvents([]);
          }
        }
        return updated;
      });
      if (selectedWorktreeId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(selectedWorktreeId) });
      }
      // Prune tracking refs for the deleted thread
      seenEventIdsByThreadRef.current.delete(threadId);
      lastEventIdxByThreadRef.current.delete(threadId);
      loggedOrphanEventIdsByThreadRef.current.delete(threadId);
      // Prune stale entries if tracking refs grow too large
      if (seenEventIdsByThreadRef.current.size > 10) {
        const activeThreadIds = new Set(threads.map(t => t.id));
        for (const key of [...seenEventIdsByThreadRef.current.keys()]) {
          if (!activeThreadIds.has(key)) {
            seenEventIdsByThreadRef.current.delete(key);
            lastEventIdxByThreadRef.current.delete(key);
            loggedOrphanEventIdsByThreadRef.current.delete(key);
          }
        }
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to close session");
    } finally {
      setClosingThreadId(null);
    }
  }

  // ── Chat actions ──

  async function submitMessage(content?: string, messageAttachments?: PendingAttachment[]) {
    const messageContent = content ?? chatInput;
    const attachmentsToSend: AttachmentInput[] = (messageAttachments ?? pendingAttachments).map((att) => ({
      id: att.id,
      filename: att.filename,
      mimeType: att.mimeType,
      content: att.content,
      source: att.source,
    }));

    if (!selectedThreadId || (!messageContent.trim() && attachmentsToSend.length === 0)) return;

    startWaitingAssistant(selectedThreadId);
    setSendingMessage(true);
    onError(null);

    try {
      await api.sendMessage(selectedThreadId, { content: messageContent, mode: chatMode, attachments: attachmentsToSend });
      setChatInput("");
      setPendingAttachments([]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.messages(selectedThreadId) });
    } catch (e) {
      setWaitingAssistant(null);
      onError(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setSendingMessage(false);
    }
  }

  async function stopAssistantRun() {
    if (!selectedThreadId) return;
    const threadId = selectedThreadId;
    if (stopRequestedThreadId === threadId) return;

    setStopRequestedThreadId(threadId);
    setStoppingThreadId(threadId);
    onError(null);

    try {
      await api.stopRun(threadId);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to stop run");
      setStopRequestedThreadId((c) => (c === threadId ? null : c));
    } finally {
      setStoppingThreadId((c) => (c === threadId ? null : c));
    }
  }

  // ── Derived flags ──

  const hasStreamingAssistantMessage =
    selectedThreadId != null &&
    messages.some(
      (m) =>
        m.threadId === selectedThreadId &&
        m.role === "assistant" &&
        streamingMessageIdsRef.current.has(m.id),
    );

  const showStopAction =
    selectedThreadId != null &&
    (sendingMessage || waitingAssistant?.threadId === selectedThreadId || hasStreamingAssistantMessage);

  const stopRequestedForActiveThread = selectedThreadId != null && stopRequestedThreadId === selectedThreadId;
  const stoppingRun =
    selectedThreadId != null && (stoppingThreadId === selectedThreadId || stopRequestedForActiveThread);

  useEffect(() => {
    if (!showStopAction) setStopRequestedThreadId(null);
  }, [showStopAction]);

  // ── Timeline ──

  const timelineRefsRef = useRef<TimelineRefs>({
    streamingMessageIds: streamingMessageIdsRef.current,
    stickyRawFallbackMessageIds: stickyRawFallbackMessageIdsRef.current,
    renderDecisionByMessageId: renderDecisionByMessageIdRef.current,
    loggedOrphanEventIdsByThread: loggedOrphanEventIdsByThreadRef.current,
  });
  timelineRefsRef.current.streamingMessageIds = streamingMessageIdsRef.current;
  timelineRefsRef.current.stickyRawFallbackMessageIds = stickyRawFallbackMessageIdsRef.current;
  timelineRefsRef.current.renderDecisionByMessageId = renderDecisionByMessageIdRef.current;
  timelineRefsRef.current.loggedOrphanEventIdsByThread = loggedOrphanEventIdsByThreadRef.current;

  const timelineItems = useWorkspaceTimeline(messages, events, selectedThreadId, timelineRefsRef.current);

  return {
    threads,
    selectedThreadId,
    setSelectedThreadId,
    messages,
    events,
    closingThreadId,

    chatInput,
    setChatInput,
    chatMode,
    setChatMode,
    pendingAttachments,
    setPendingAttachments,

    sendingMessage,
    waitingAssistant,
    showStopAction,
    stoppingRun,

    timelineItems,

    createAdditionalThread,
    createThreadAndSendMessage,
    closeThread,
    submitMessage,
    stopAssistantRun,

    startWaitingAssistant,
    clearWaitingAssistantForThread,
  };
}
