import { useEffect, useRef, useState } from "react";
import type { ChatEvent, ChatMessage, ChatMode, ChatThread } from "@codesymphony/shared-types";
import { api } from "../../../lib/api";
import { logService } from "../../../lib/logService";
import { pushRenderDebug } from "../../../lib/renderDebug";
import { EVENT_TYPES } from "../constants";
import { payloadStringOrNull, shouldClearWaitingAssistantOnEvent } from "../eventUtils";
import { useWorkspaceTimeline, type TimelineRefs } from "./useWorkspaceTimeline";

export function useChatSession(
  selectedWorktreeId: string | null,
  onError: (msg: string | null) => void,
  onBranchRenamed?: (worktreeId: string, newBranch: string) => void,
) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<ChatEvent[]>([]);

  const [chatInput, setChatInput] = useState("");
  const [chatMode, setChatMode] = useState<ChatMode>("default");

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

  async function ensureThread(worktreeId: string): Promise<string | null> {
    const existing = await api.listThreads(worktreeId);
    setThreads(existing);
    if (existing.length > 0) return existing[0].id;
    const created = await api.createThread(worktreeId, { title: "Main Thread" });
    setThreads([created]);
    return created.id;
  }

  async function loadThreadData(threadId: string) {
    const [threadMessages, threadEvents] = await Promise.all([
      api.listMessages(threadId),
      api.listEvents(threadId),
    ]);
    // Merge loaded data with existing state to prevent SSE-delivered events
    // from being temporarily lost when loadThreadData races with streaming.
    setMessages((current) => {
      const merged = new Map<string, ChatMessage>();
      for (const m of threadMessages) merged.set(m.id, m);
      for (const m of current) {
        const existing = merged.get(m.id);
        // Prefer current state if it has more content (streaming delta appended)
        if (existing && m.content.length > existing.content.length) {
          merged.set(m.id, m);
        } else if (!existing) {
          // Keep messages from SSE that aren't in DB yet (edge case)
          merged.set(m.id, m);
        }
      }
      return [...merged.values()].sort((a, b) => a.seq - b.seq);
    });

    // Events: merge by id, deduplicate
    setEvents((current) => {
      const seen = new Set<string>();
      const merged: ChatEvent[] = [];
      for (const e of threadEvents) { seen.add(e.id); merged.push(e); }
      for (const e of current) { if (!seen.has(e.id)) merged.push(e); }
      return merged.sort((a, b) => a.idx - b.idx);
    });
    pushRenderDebug({
      source: "WorkspacePage",
      event: "loadThreadData",
      details: { threadId, messages: threadMessages.length, events: threadEvents.length },
    });

    const seenEventIds = new Set<string>();
    let lastIdx: number | null = null;
    let latestThreadTitle: string | null = null;
    let latestWorktreeBranch: string | null = null;
    for (const event of threadEvents) {
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
      setThreads((current) =>
        current.map((t) =>
          t.id === threadId ? { ...t, title: latestThreadTitle } : t,
        ),
      );
    }

    if (latestWorktreeBranch && selectedWorktreeId) {
      onBranchRenamed?.(selectedWorktreeId, latestWorktreeBranch);
    }

    seenEventIdsByThreadRef.current.set(threadId, seenEventIds);
    if (lastIdx == null) {
      lastEventIdxByThreadRef.current.delete(threadId);
    } else {
      lastEventIdxByThreadRef.current.set(threadId, lastIdx);
    }
  }

  // ── Worktree change → load threads ──

  useEffect(() => {
    if (!selectedWorktreeId) {
      setWaitingAssistant(null);
      setThreads([]);
      setSelectedThreadId(null);
      setMessages([]);
      setEvents([]);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const threadId = await ensureThread(selectedWorktreeId);
        if (!threadId || cancelled) return;
        setSelectedThreadId(threadId);
      } catch (e) {
        if (!cancelled) onError(e instanceof Error ? e.message : "Failed to load threads");
      }
    })();

    return () => { cancelled = true; };
  }, [selectedWorktreeId]);

  // ── Thread change → load data + start SSE stream ──

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
    setWaitingAssistant(null);
    setStoppingThreadId(null);
    setStopRequestedThreadId(null);

    let disposed = false;
    let stream: EventSource | null = null;

    void (async () => {
      try {
        await loadThreadData(selectedThreadId);
      } catch (e) {
        if (!disposed) onError(e instanceof Error ? e.message : "Failed to load thread");
        return;
      }

      if (disposed) return;

      const streamUrl = new URL(`${api.runtimeBaseUrl}/api/threads/${selectedThreadId}/events/stream`);
      const lastEventIdx = lastEventIdxByThreadRef.current.get(selectedThreadId);
      if (typeof lastEventIdx === "number") {
        streamUrl.searchParams.set("afterIdx", String(lastEventIdx));
      }

      stream = new EventSource(streamUrl.toString());

      const onEvent = (rawEvent: MessageEvent<string>) => {
        if (disposed) return;

        const payload = JSON.parse(rawEvent.data) as ChatEvent;
        const seenEventIds = ensureSeenEventIds(selectedThreadId);
        if (seenEventIds.has(payload.id)) {
          pushRenderDebug({
            source: "WorkspacePage",
            event: "streamEventSkippedDuplicate",
            messageId: String(payload.payload.messageId ?? ""),
            details: { eventId: payload.id, type: payload.type, idx: payload.idx },
          });
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
          });
        }

        setWaitingAssistant((current) => {
          if (!current || current.threadId !== selectedThreadId || payload.idx <= current.afterIdx) return current;
          if (shouldClearWaitingAssistantOnEvent(payload)) return null;
          return current;
        });

        setEvents((current) => [...current, payload].sort((a, b) => a.idx - b.idx));

        // Create a placeholder assistant message as soon as thinking starts
        // so that tool events arriving before the first message.delta are
        // claimed by the timeline instead of becoming orphans.
        if (payload.type === "thinking.delta") {
          const messageId = String(payload.payload.messageId ?? "");
          if (messageId.length > 0) {
            streamingMessageIdsRef.current.add(messageId);
            setMessages((current) => {
              if (current.some((m) => m.id === messageId)) return current;
              return [
                ...current,
                {
                  id: messageId,
                  threadId: selectedThreadId,
                  seq: current.length,
                  role: "assistant" as const,
                  content: "",
                  createdAt: new Date().toISOString(),
                },
              ];
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

          if (messageId.length === 0) return;
          if (role === "assistant") streamingMessageIdsRef.current.add(messageId);

          setMessages((current) => {
            const existing = current.find((m) => m.id === messageId);
            if (!existing) {
              return [
                ...current,
                {
                  id: messageId,
                  threadId: selectedThreadId,
                  seq: current.length,
                  role,
                  content: delta,
                  createdAt: new Date().toISOString(),
                },
              ];
            }
            if (role === "user") return current;
            return current.map((m) =>
              m.id === messageId ? { ...m, content: m.content + delta } : m,
            );
          });
        }

        if (payload.type === "chat.completed") {
          const completedMessageId = String(payload.payload.messageId ?? "");
          const completedThreadTitle = payloadStringOrNull(payload.payload.threadTitle);
          const completedBranch = payloadStringOrNull(payload.payload.worktreeBranch);
          if (completedMessageId.length > 0) streamingMessageIdsRef.current.delete(completedMessageId);
          if (completedThreadTitle) {
            setThreads((current) =>
              current.map((t) =>
                t.id === selectedThreadId ? { ...t, title: completedThreadTitle } : t,
              ),
            );
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
          void loadThreadData(selectedThreadId);
        }
      };

      for (const eventType of EVENT_TYPES) {
        stream.addEventListener(eventType, onEvent as EventListener);
      }

      stream.onerror = () => {
        if (!disposed && stream && stream.readyState === EventSource.CLOSED) {
          onError("Lost connection to chat stream");
        }
      };
    })();

    return () => {
      disposed = true;
      stream?.close();
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
      startWaitingAssistant(created.id);
      setSendingMessage(true);
      try {
        await api.sendMessage(created.id, { content, mode: chatMode });
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
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to close session");
    } finally {
      setClosingThreadId(null);
    }
  }

  // ── Chat actions ──

  async function submitMessage(content?: string) {
    const messageContent = content ?? chatInput;
    if (!selectedThreadId || !messageContent.trim()) return;

    startWaitingAssistant(selectedThreadId);
    setSendingMessage(true);
    onError(null);

    try {
      await api.sendMessage(selectedThreadId, { content: messageContent, mode: chatMode });
      setChatInput("");
      await loadThreadData(selectedThreadId);
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
