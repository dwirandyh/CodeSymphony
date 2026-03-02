import {
  startTransition,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ChatEvent,
  ChatEventsPage,
  ChatMessage,
  ChatMessagesPage,
  ChatMode,
  ChatThread,
  ChatThreadSnapshot,
  AttachmentInput,
} from "@codesymphony/shared-types";
import type { PendingAttachment } from "../../../lib/attachments";
import { isImageMimeType } from "../../../lib/attachments";
import { api } from "../../../lib/api";
import { queryKeys } from "../../../lib/queryKeys";
import { logService } from "../../../lib/logService";
import { pushRenderDebug } from "../../../lib/renderDebug";
import { debugLog } from "../../../lib/debugLog";
import { useThreads } from "../../../hooks/queries/useThreads";
import { useThreadSnapshot } from "../../../hooks/queries/useThreadSnapshot";
import { EVENT_TYPES, INITIAL_EVENTS_PAGE_LIMIT, INITIAL_MESSAGES_PAGE_LIMIT } from "../constants";
import { payloadStringOrNull, shouldClearWaitingAssistantOnEvent } from "../eventUtils";
import { useWorkspaceTimeline, type TimelineRefs } from "./useWorkspaceTimeline";
import { areMessageArraysEqual, mergeThreadMessages } from "./messageMerge";

type PendingMessageMutation =
  | { kind: "ensure-placeholder"; id: string; threadId: string }
  | { kind: "message-delta"; id: string; threadId: string; role: "assistant" | "user"; delta: string };

type LoadOlderHistoryRequestMetadata = {
  cycleId?: number;
  requestId?: string;
};

type LoadOlderHistoryResult = {
  cycleId: number | null;
  requestId: string;
  completionReason: "applied" | "empty-cursors" | "thread-changed";
  messagesAdded: number;
  eventsAdded: number;
  estimatedRenderableGrowth: boolean;
};

const AUTO_BACKFILL_MAX_PAGES = 4;

type AutoBackfillStopReason =
  | "token-or-thread-changed"
  | "loading-older-history"
  | "no-more-events"
  | "no-result"
  | "completion-reason"
  | "no-progress"
  | "timeline-complete"
  | "max-pages";

type AutoBackfillLoopOutcome = {
  pagesLoaded: number;
  stopReason: AutoBackfillStopReason;
};

type AutoBackfillLoopInput = {
  maxPages: number;
  shouldAbort: () => boolean;
  isLoadingOlderHistory: () => boolean;
  getBeforeIdx: () => number | null;
  loadOlderHistoryPage: (pageNumber: number) => Promise<LoadOlderHistoryResult | void>;
  isTimelineIncomplete: () => boolean;
};

export function shouldAutoBackfillOnHydration(
  snapshot: ChatThreadSnapshot,
  timelineHasIncompleteCoverage: boolean,
): boolean {
  return snapshot.coverage.eventsStatus !== "complete"
    || snapshot.coverage.recommendedBackfill
    || timelineHasIncompleteCoverage;
}

export function buildAutoBackfillSnapshotKey(snapshot: ChatThreadSnapshot): string {
  const { watermarks, coverage } = snapshot;
  return [
    watermarks.newestSeq ?? "null",
    watermarks.newestIdx ?? "null",
    coverage.eventsStatus,
    coverage.recommendedBackfill ? "1" : "0",
    coverage.nextBeforeIdx ?? "null",
  ].join(":");
}

export async function runAutoBackfillLoop(input: AutoBackfillLoopInput): Promise<AutoBackfillLoopOutcome> {
  let pagesLoaded = 0;
  let previousBeforeIdx: number | null = input.getBeforeIdx();

  while (pagesLoaded < input.maxPages) {
    if (input.shouldAbort()) {
      return { pagesLoaded, stopReason: "token-or-thread-changed" };
    }

    if (input.isLoadingOlderHistory()) {
      return { pagesLoaded, stopReason: "loading-older-history" };
    }

    const beforeIdx = input.getBeforeIdx();
    if (beforeIdx == null) {
      return { pagesLoaded, stopReason: "no-more-events" };
    }

    const result = await input.loadOlderHistoryPage(pagesLoaded + 1);
    pagesLoaded += 1;

    if (!result) {
      return { pagesLoaded, stopReason: "no-result" };
    }

    if (result.completionReason !== "applied") {
      return { pagesLoaded, stopReason: "completion-reason" };
    }

    const nextBeforeIdx = input.getBeforeIdx();
    if (result.eventsAdded === 0 || nextBeforeIdx === previousBeforeIdx) {
      return { pagesLoaded, stopReason: "no-progress" };
    }

    previousBeforeIdx = nextBeforeIdx;

    if (!input.isTimelineIncomplete()) {
      return { pagesLoaded, stopReason: "timeline-complete" };
    }
  }

  return { pagesLoaded, stopReason: "max-pages" };
}

export function prependUniqueMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current;
  const seen = new Set<string>();
  const merged: ChatMessage[] = [];
  for (const message of incoming) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  for (const message of current) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged.sort((a, b) => a.seq - b.seq);
}

export function prependUniqueEvents(current: ChatEvent[], incoming: ChatEvent[]): ChatEvent[] {
  if (incoming.length === 0) return current;
  const seen = new Set<string>();
  const merged: ChatEvent[] = [];
  for (const event of incoming) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  for (const event of current) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged.sort((a, b) => a.idx - b.idx);
}

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

export function mergeEventsWithCurrent(queriedEvents: ChatEvent[], current: ChatEvent[]): ChatEvent[] {
  if (current.length > 0 && queriedEvents.length > 0) {
    const currentLastIdx = current[current.length - 1].idx;
    const queriedLastIdx = queriedEvents[queriedEvents.length - 1].idx;
    if (current.length >= queriedEvents.length && currentLastIdx >= queriedLastIdx) {
      return current;
    }
  }

  const seen = new Set<string>();
  const merged: ChatEvent[] = [];
  for (const e of queriedEvents) {
    seen.add(e.id);
    merged.push(e);
  }
  for (const e of current) {
    if (!seen.has(e.id)) {
      merged.push(e);
    }
  }
  const sorted = merged.sort((a, b) => a.idx - b.idx);
  if (sorted.length === current.length && sorted.every((e, i) => e.id === current[i].id && e.idx === current[i].idx)) {
    return current;
  }
  return sorted;
}

function applySnapshotSeed(params: {
  snapshot: ChatThreadSnapshot;
  selectedThreadId: string;
  selectedWorktreeId: string | null;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setEvents: Dispatch<SetStateAction<ChatEvent[]>>;
  setThreads: Dispatch<SetStateAction<ChatThread[]>>;
  setHasMoreOlderMessages: Dispatch<SetStateAction<boolean>>;
  setHasMoreOlderEvents: Dispatch<SetStateAction<boolean>>;
  nextBeforeSeqByThreadRef: MutableRefObject<Map<string, number | null>>;
  nextBeforeIdxByThreadRef: MutableRefObject<Map<string, number | null>>;
  seenEventIdsByThreadRef: MutableRefObject<Map<string, Set<string>>>;
  lastEventIdxByThreadRef: MutableRefObject<Map<string, number>>;
  activeThreadIdRef: MutableRefObject<string | null>;
  onBranchRenamed?: (worktreeId: string, newBranch: string) => void;
}) {
  const {
    snapshot,
    selectedThreadId,
    selectedWorktreeId,
    setMessages,
    setEvents,
    setThreads,
    setHasMoreOlderMessages,
    setHasMoreOlderEvents,
    nextBeforeSeqByThreadRef,
    nextBeforeIdxByThreadRef,
    seenEventIdsByThreadRef,
    lastEventIdxByThreadRef,
    activeThreadIdRef,
    onBranchRenamed,
  } = params;

  const queriedMessages = snapshot.messages.data;
  const queriedEvents = snapshot.events.data;

  setMessages((current) => {
    if (current.length === 0) {
      return [...queriedMessages].sort((a, b) => a.seq - b.seq);
    }
    const sorted = mergeThreadMessages(queriedMessages, current);
    if (areMessageArraysEqual(sorted, current)) {
      return current;
    }
    return sorted;
  });

  setEvents((current) => {
    if (current.length === 0) {
      return [...queriedEvents].sort((a, b) => a.idx - b.idx);
    }
    return mergeEventsWithCurrent(queriedEvents, current);
  });

  nextBeforeSeqByThreadRef.current.set(selectedThreadId, snapshot.messages.pageInfo.nextBeforeSeq);
  nextBeforeIdxByThreadRef.current.set(selectedThreadId, snapshot.events.pageInfo.nextBeforeIdx);

  if (activeThreadIdRef.current === selectedThreadId) {
    setHasMoreOlderMessages(snapshot.messages.pageInfo.hasMoreOlder);
    setHasMoreOlderEvents(snapshot.events.pageInfo.hasMoreOlder);
  }

  const seenEventIds = new Set<string>();
  for (const event of queriedEvents) {
    seenEventIds.add(event.id);
  }
  seenEventIdsByThreadRef.current.set(selectedThreadId, seenEventIds);

  if (snapshot.watermarks.newestIdx == null) {
    lastEventIdxByThreadRef.current.delete(selectedThreadId);
  } else {
    lastEventIdxByThreadRef.current.set(selectedThreadId, snapshot.watermarks.newestIdx);
  }

  const latestMetadata = extractLatestThreadMetadata(queriedEvents);
  if (latestMetadata.threadTitle) {
    setThreads((current) => applyThreadTitleUpdate(current, selectedThreadId, latestMetadata.threadTitle));
  }

  if (latestMetadata.worktreeBranch && selectedWorktreeId) {
    onBranchRenamed?.(selectedWorktreeId, latestMetadata.worktreeBranch);
  }
}

type ThreadMetadataSnapshot = {
  threadTitle: string | null;
  worktreeBranch: string | null;
};

export function extractLatestThreadMetadata(events: ChatEvent[]): ThreadMetadataSnapshot {
  let latestThreadTitle: string | null = null;
  let latestWorktreeBranch: string | null = null;

  for (const event of events) {
    if (event.type === "chat.completed") {
      const completedThreadTitle = payloadStringOrNull(event.payload.threadTitle);
      const completedWorktreeBranch = payloadStringOrNull(event.payload.worktreeBranch);
      if (completedThreadTitle) {
        latestThreadTitle = completedThreadTitle;
      }
      if (completedWorktreeBranch) {
        latestWorktreeBranch = completedWorktreeBranch;
      }
      continue;
    }

    if (event.type === "tool.finished" && payloadStringOrNull(event.payload.source) === "chat.thread.metadata") {
      const metadataThreadTitle = payloadStringOrNull(event.payload.threadTitle);
      const metadataWorktreeBranch = payloadStringOrNull(event.payload.worktreeBranch);
      if (metadataThreadTitle) {
        latestThreadTitle = metadataThreadTitle;
      }
      if (metadataWorktreeBranch) {
        latestWorktreeBranch = metadataWorktreeBranch;
      }
    }
  }

  return {
    threadTitle: latestThreadTitle,
    worktreeBranch: latestWorktreeBranch,
  };
}

export function applyThreadTitleUpdate(
  currentThreads: ChatThread[],
  threadId: string | null,
  threadTitle: string | null,
): ChatThread[] {
  if (!threadId || !threadTitle) {
    return currentThreads;
  }

  const index = currentThreads.findIndex((thread) => thread.id === threadId);
  if (index === -1 || currentThreads[index].title === threadTitle) {
    return currentThreads;
  }

  const updated = [...currentThreads];
  updated[index] = { ...updated[index], title: threadTitle };
  return updated;
}

interface UseChatSessionOptions {
  initialThreadId?: string;
  onThreadChange?: (threadId: string | null) => void;
  selectedRepositoryId?: string | null;
  onWorktreeResolved?: (worktreeId: string) => void;
}

export function useChatSession(
  selectedWorktreeId: string | null,
  onError: (msg: string | null) => void,
  onBranchRenamed?: (worktreeId: string, newBranch: string) => void,
  options?: UseChatSessionOptions,
) {
  const queryClient = useQueryClient();

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
  const [hasMoreOlderMessages, setHasMoreOlderMessages] = useState(false);
  const [hasMoreOlderEvents, setHasMoreOlderEvents] = useState(false);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);

  const seenEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const lastEventIdxByThreadRef = useRef<Map<string, number>>(new Map());
  const nextBeforeSeqByThreadRef = useRef<Map<string, number | null>>(new Map());
  const nextBeforeIdxByThreadRef = useRef<Map<string, number | null>>(new Map());
  const streamingMessageIdsRef = useRef<Set<string>>(new Set());
  const stickyRawFallbackMessageIdsRef = useRef<Set<string>>(new Set());
  const renderDecisionByMessageIdRef = useRef<Map<string, string>>(new Map());
  const loggedOrphanEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const activeThreadIdRef = useRef<string | null>(null);
  const initialThreadAppliedRef = useRef(false);
  const creatingThreadRef = useRef(false);
  const prevThreadIdRef = useRef<string | null>(null);
  const prevSeedThreadRef = useRef<string | null>(null);
  const restoredActiveThreadIdsRef = useRef<Set<string>>(new Set());
  const pendingEventsRef = useRef<ChatEvent[]>([]);
  const pendingMessageMutationsRef = useRef<PendingMessageMutation[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const loadOlderRequestCounterRef = useRef(0);
  const autoBackfillRunTokenByThreadRef = useRef<Map<string, number>>(new Map());
  const autoBackfillRequestCounterRef = useRef(0);
  const seededSnapshotKeyByThreadRef = useRef<Map<string, string>>(new Map());

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
      setHasMoreOlderMessages(false);
      setHasMoreOlderEvents(false);
      setLoadingOlderHistory(false);
      setThreads([]);
      setSelectedThreadId(null);
      setMessages([]);
      setEvents([]);
      return;
    }

    // Worktree changed → reset transient state
    if (worktreeChanged) {
      setWaitingAssistant(null);
      setHasMoreOlderMessages(false);
      setHasMoreOlderEvents(false);
      setLoadingOlderHistory(false);
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

  // ── TanStack Query: thread snapshot (initial seed) ──
  const { data: queriedThreadSnapshot } = useThreadSnapshot(selectedThreadId);
  const prevQueriedSnapshotRef = useRef(queriedThreadSnapshot);
  if (prevQueriedSnapshotRef.current !== queriedThreadSnapshot) {
    debugLog("useChatSession", "queriedThreadSnapshot ref changed", {
      prevMessagesLength: prevQueriedSnapshotRef.current?.messages.data.length ?? null,
      prevEventsLength: prevQueriedSnapshotRef.current?.events.data.length ?? null,
      newMessagesLength: queriedThreadSnapshot?.messages.data.length ?? null,
      newEventsLength: queriedThreadSnapshot?.events.data.length ?? null,
    });
    prevQueriedSnapshotRef.current = queriedThreadSnapshot;
  }

  useEffect(() => {
    const threadChanged = prevSeedThreadRef.current !== selectedThreadId;
    debugLog("useChatSession", "seed snapshot effect", {
      selectedThreadId,
      threadChanged,
      queriedMessagesLength: queriedThreadSnapshot?.messages.data.length ?? null,
      queriedEventsLength: queriedThreadSnapshot?.events.data.length ?? null,
    });

    if (threadChanged) {
      prevSeedThreadRef.current = selectedThreadId;
      if (!queriedThreadSnapshot || !selectedThreadId) {
        if (selectedThreadId) {
          seededSnapshotKeyByThreadRef.current.delete(selectedThreadId);
        }
        setMessages([]);
        setEvents([]);
        return;
      }

      applySnapshotSeed({
        snapshot: queriedThreadSnapshot,
        selectedThreadId,
        selectedWorktreeId,
        setMessages,
        setEvents,
        setThreads,
        setHasMoreOlderMessages,
        setHasMoreOlderEvents,
        nextBeforeSeqByThreadRef,
        nextBeforeIdxByThreadRef,
        seenEventIdsByThreadRef,
        lastEventIdxByThreadRef,
        activeThreadIdRef,
        onBranchRenamed,
      });
      seededSnapshotKeyByThreadRef.current.set(
        selectedThreadId,
        buildAutoBackfillSnapshotKey(queriedThreadSnapshot),
      );
      return;
    }

    if (!queriedThreadSnapshot || !selectedThreadId) return;

    applySnapshotSeed({
      snapshot: queriedThreadSnapshot,
      selectedThreadId,
      selectedWorktreeId,
      setMessages,
      setEvents,
      setThreads,
      setHasMoreOlderMessages,
      setHasMoreOlderEvents,
      nextBeforeSeqByThreadRef,
      nextBeforeIdxByThreadRef,
      seenEventIdsByThreadRef,
      lastEventIdxByThreadRef,
      activeThreadIdRef,
      onBranchRenamed,
    });
    seededSnapshotKeyByThreadRef.current.set(
      selectedThreadId,
      buildAutoBackfillSnapshotKey(queriedThreadSnapshot),
    );
  }, [onBranchRenamed, queriedThreadSnapshot, selectedThreadId, selectedWorktreeId]);

  useEffect(() => {
    if (!selectedThreadId) {
      seededSnapshotKeyByThreadRef.current.clear();
      autoBackfillRunTokenByThreadRef.current.clear();
      return;
    }

    return () => {
      seededSnapshotKeyByThreadRef.current.delete(selectedThreadId);
      autoBackfillRunTokenByThreadRef.current.delete(selectedThreadId);
    };
  }, [selectedThreadId]);

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
    debugLog("useChatSession", "waitingAssistant set", { threadId, afterIdx, reason: "startWaitingAssistant" });
    setWaitingAssistant({ threadId, afterIdx });
  }

  function clearWaitingAssistantForThread(threadId: string) {
    debugLog("useChatSession", "waitingAssistant clear requested", { threadId, reason: "clearWaitingAssistantForThread" });
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
      setHasMoreOlderMessages(false);
      setHasMoreOlderEvents(false);
      setLoadingOlderHistory(false);
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
    setHasMoreOlderMessages(nextBeforeSeqByThreadRef.current.get(selectedThreadId) != null);
    setHasMoreOlderEvents(nextBeforeIdxByThreadRef.current.get(selectedThreadId) != null);
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
        // Invalidate messages query to re-seed fresh data.
        // NOTE: Do NOT invalidate events here — local state is already fully
        // up-to-date from SSE. Re-fetching events triggers a merge that
        // produces a new array reference on every cycle, causing an infinite
        // render loop ("Maximum update depth exceeded") on large threads.
        void queryClient.invalidateQueries({ queryKey: queryKeys.threads.snapshot(selectedThreadId) });
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

    // Wait a tick for query data to seed, then start SSE
    const MAX_RECONNECT_ATTEMPTS = 5;
    const BASE_RECONNECT_DELAY_MS = 1000;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const startStream = () => {
      if (disposed) return;

      // Pre-seed seenEventIds and lastEventIdx from snapshot cache so the SSE
      // stream doesn't replay events we already have.
      const cachedSnapshot = queryClient.getQueryData<ChatThreadSnapshot>(
        queryKeys.threads.snapshot(selectedThreadId),
      );
      const cachedEvents = cachedSnapshot?.events;
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

    // Wait for snapshot query to complete, then pre-seed dedup state and start SSE
    void (async () => {
      try {
        const snapshot = await queryClient.fetchQuery({
          queryKey: queryKeys.threads.snapshot(selectedThreadId),
          queryFn: () => api.getThreadSnapshot(selectedThreadId, {
            messageLimit: INITIAL_MESSAGES_PAGE_LIMIT,
            eventLimit: INITIAL_EVENTS_PAGE_LIMIT,
          }),
        });
        if (disposed) return;
        const snapshotEvents = snapshot.events;
        if (snapshotEvents.data.length > 0) {
          const seenEventIds = ensureSeenEventIds(selectedThreadId);
          for (const e of snapshotEvents.data) {
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
      const matchedEvent = events.find(
        (event) => event.idx > current.afterIdx && shouldClearWaitingAssistantOnEvent(event),
      );
      if (matchedEvent) {
        debugLog("useChatSession", "waitingAssistant cleared by events effect", {
          selectedThreadId,
          eventType: matchedEvent.type,
          eventIdx: matchedEvent.idx,
          afterIdx: current.afterIdx,
        });
        return null;
      }
      return current;
    });
  }, [events, selectedThreadId]);

  // ── Thread CRUD ──

  async function createThreadInCurrentContext(title: string): Promise<{ created: ChatThread; worktreeId: string } | null> {
    if (selectedWorktreeId) {
      const created = await api.createThread(selectedWorktreeId, { title });
      return { created, worktreeId: selectedWorktreeId };
    }

    const repositoryId = options?.selectedRepositoryId ?? null;
    if (!repositoryId) {
      return null;
    }

    const created = await api.createRepositoryThread(repositoryId, { title });
    options?.onWorktreeResolved?.(created.worktreeId);
    void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.all });
    return { created, worktreeId: created.worktreeId };
  }

  async function createAdditionalThread() {
    onError(null);

    try {
      const result = await createThreadInCurrentContext(`Thread ${threads.length + 1}`);
      if (!result) return;

      const { created, worktreeId } = result;
      setThreads((current) => {
        if (current.some((t) => t.id === created.id)) return current;
        return [...current, created];
      });
      setSelectedThreadId(created.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(worktreeId) });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create thread");
    }
  }

  async function createThreadAndSendMessage(title: string, content: string) {
    onError(null);

    try {
      const result = await createThreadInCurrentContext(title);
      if (!result) return;

      const { created, worktreeId } = result;
      setThreads((current) => {
        if (current.some((t) => t.id === created.id)) return current;
        return [...current, created];
      });
      setSelectedThreadId(created.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(worktreeId) });
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
      nextBeforeSeqByThreadRef.current.delete(threadId);
      nextBeforeIdxByThreadRef.current.delete(threadId);
      loggedOrphanEventIdsByThreadRef.current.delete(threadId);
      // Prune stale entries if tracking refs grow too large
      if (seenEventIdsByThreadRef.current.size > 10) {
        const activeThreadIds = new Set(threads.map(t => t.id));
        for (const key of [...seenEventIdsByThreadRef.current.keys()]) {
          if (!activeThreadIds.has(key)) {
            seenEventIdsByThreadRef.current.delete(key);
            lastEventIdxByThreadRef.current.delete(key);
            nextBeforeSeqByThreadRef.current.delete(key);
            nextBeforeIdxByThreadRef.current.delete(key);
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

  async function renameThreadTitle(threadId: string, title: string) {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      return;
    }

    onError(null);

    try {
      const updated = await api.renameThreadTitle(threadId, { title: normalizedTitle });
      setThreads((current) => applyThreadTitleUpdate(current, updated.id, updated.title));

      const cacheWorktreeId = selectedWorktreeId ?? updated.worktreeId;
      if (cacheWorktreeId) {
        queryClient.setQueryData<ChatThread[] | undefined>(
          queryKeys.threads.list(cacheWorktreeId),
          (current) => {
            if (!current) {
              return current;
            }
            return applyThreadTitleUpdate(current, updated.id, updated.title);
          },
        );
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to rename thread title");
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

    debugLog("useChatSession", "submitMessage start", {
      selectedThreadId,
      contentLength: messageContent.length,
      attachmentsCount: attachmentsToSend.length,
    });
    startWaitingAssistant(selectedThreadId);
    setSendingMessage(true);
    onError(null);

    try {
      await api.sendMessage(selectedThreadId, { content: messageContent, mode: chatMode, attachments: attachmentsToSend });
      debugLog("useChatSession", "submitMessage ack", { selectedThreadId });
      setChatInput("");
      setPendingAttachments([]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.snapshot(selectedThreadId) });
    } catch (e) {
      debugLog("useChatSession", "submitMessage failed", {
        selectedThreadId,
        error: e instanceof Error ? e.message : String(e),
      });
      setWaitingAssistant(null);
      onError(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      debugLog("useChatSession", "submitMessage end", { selectedThreadId });
      setSendingMessage(false);
    }
  }

  async function loadOlderHistory(metadata?: LoadOlderHistoryRequestMetadata): Promise<LoadOlderHistoryResult | void> {
    if (!selectedThreadId || loadingOlderHistory) return;

    const threadId = selectedThreadId;
    const beforeSeq = nextBeforeSeqByThreadRef.current.get(threadId) ?? null;
    const beforeIdx = nextBeforeIdxByThreadRef.current.get(threadId) ?? null;
    const requestNumber = loadOlderRequestCounterRef.current + 1;
    loadOlderRequestCounterRef.current = requestNumber;
    const cycleId = metadata?.cycleId ?? null;
    const requestId = metadata?.requestId ?? `load-older-${threadId}-${requestNumber}`;

    if (beforeSeq == null && beforeIdx == null) {
      setHasMoreOlderMessages(false);
      setHasMoreOlderEvents(false);
      debugLog("useChatSession", "loadOlderHistory skipped empty cursors", {
        threadId,
        cycleId,
        requestId,
      });
      return {
        cycleId,
        requestId,
        completionReason: "empty-cursors",
        messagesAdded: 0,
        eventsAdded: 0,
        estimatedRenderableGrowth: false,
      };
    }

    setLoadingOlderHistory(true);
    onError(null);
    debugLog("useChatSession", "loadOlderHistory start", { threadId, beforeSeq, beforeIdx, cycleId, requestId });

    try {
      const [messagesPage, eventsPage] = await Promise.all([
        beforeSeq == null
          ? Promise.resolve<ChatMessagesPage | null>(null)
          : api.listMessagesPage(threadId, {
            beforeSeq,
            limit: INITIAL_MESSAGES_PAGE_LIMIT,
          }),
        beforeIdx == null
          ? Promise.resolve<ChatEventsPage | null>(null)
          : api.listEventsPage(threadId, {
            beforeIdx,
            limit: INITIAL_EVENTS_PAGE_LIMIT,
          }),
      ]);

      if (selectedThreadId !== threadId) {
        debugLog("useChatSession", "loadOlderHistory skipped thread changed", {
          threadId,
          selectedThreadId,
          cycleId,
          requestId,
        });
        return {
          cycleId,
          requestId,
          completionReason: "thread-changed",
          messagesAdded: 0,
          eventsAdded: 0,
          estimatedRenderableGrowth: false,
        };
      }

      if (messagesPage) {
        nextBeforeSeqByThreadRef.current.set(threadId, messagesPage.pageInfo.nextBeforeSeq);
        setHasMoreOlderMessages(messagesPage.pageInfo.hasMoreOlder);
      } else {
        nextBeforeSeqByThreadRef.current.set(threadId, null);
        setHasMoreOlderMessages(false);
      }

      if (eventsPage) {
        nextBeforeIdxByThreadRef.current.set(threadId, eventsPage.pageInfo.nextBeforeIdx);
        setHasMoreOlderEvents(eventsPage.pageInfo.hasMoreOlder);
        const seenEventIds = ensureSeenEventIds(threadId);
        for (const event of eventsPage.data) {
          seenEventIds.add(event.id);
        }
      } else {
        nextBeforeIdxByThreadRef.current.set(threadId, null);
        setHasMoreOlderEvents(false);
      }

      const messagesAdded = messagesPage?.data.length ?? 0;
      const eventsAdded = eventsPage?.data.length ?? 0;

      debugLog("useChatSession", "loadOlderHistory page result", {
        threadId,
        cycleId,
        requestId,
        messagesPageCount: messagesAdded,
        eventsPageCount: eventsAdded,
        nextBeforeSeq: messagesPage?.pageInfo.nextBeforeSeq ?? null,
        nextBeforeIdx: eventsPage?.pageInfo.nextBeforeIdx ?? null,
        hasMoreOlderMessages: messagesPage?.pageInfo.hasMoreOlder ?? false,
        hasMoreOlderEvents: eventsPage?.pageInfo.hasMoreOlder ?? false,
      });

      if (messagesPage) {
        debugLog("useChatSession", "loadOlderHistory apply messages", {
          threadId,
          cycleId,
          requestId,
          incomingCount: messagesAdded,
        });
      }

      if (eventsPage) {
        debugLog("useChatSession", "loadOlderHistory apply events", {
          threadId,
          cycleId,
          requestId,
          incomingCount: eventsAdded,
        });
      }

      if (messagesPage) {
        setMessages((current) => prependUniqueMessages(current, messagesPage.data));
      }
      if (eventsPage) {
        setEvents((current) => prependUniqueEvents(current, eventsPage.data));
      }

      return {
        cycleId,
        requestId,
        completionReason: "applied",
        messagesAdded,
        eventsAdded,
        estimatedRenderableGrowth: messagesAdded > 0 || eventsAdded > 0,
      };
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load older history");
      throw e;
    } finally {
      debugLog("useChatSession", "loadOlderHistory end", { threadId, cycleId, requestId });
      setLoadingOlderHistory(false);
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

  const hasOlderHistory = hasMoreOlderMessages || hasMoreOlderEvents;

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

  const selectedThreadActiveFlag =
    selectedThreadId != null && threads.some((thread) => thread.id === selectedThreadId && thread.active);

  useEffect(() => {
    debugLog("useChatSession", "activity flags", {
      selectedThreadId,
      sendingMessage,
      waitingAssistant,
      hasStreamingAssistantMessage,
      showStopAction,
      selectedThreadActiveFlag,
    });
  }, [selectedThreadId, sendingMessage, waitingAssistant, hasStreamingAssistantMessage, showStopAction, selectedThreadActiveFlag]);

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

  const {
    items: timelineItems,
    hasIncompleteCoverage: timelineHasIncompleteCoverage,
  } = useWorkspaceTimeline(messages, events, selectedThreadId, timelineRefsRef.current);

  const loadingOlderHistoryRef = useRef(false);
  loadingOlderHistoryRef.current = loadingOlderHistory;

  const timelineIncompleteCoverageRef = useRef(false);
  timelineIncompleteCoverageRef.current = timelineHasIncompleteCoverage;

  useEffect(() => {
    if (!selectedThreadId || !queriedThreadSnapshot) {
      return;
    }

    const shouldAutoBackfill = shouldAutoBackfillOnHydration(queriedThreadSnapshot, timelineHasIncompleteCoverage);
    if (!shouldAutoBackfill) {
      return;
    }

    if (loadingOlderHistoryRef.current) {
      return;
    }

    const coverage = queriedThreadSnapshot.coverage;
    const initialBeforeIdx = nextBeforeIdxByThreadRef.current.get(selectedThreadId) ?? coverage.nextBeforeIdx ?? null;
    if (initialBeforeIdx == null) {
      return;
    }

    const snapshotKey = buildAutoBackfillSnapshotKey(queriedThreadSnapshot);
    const lastSeededSnapshotKey = seededSnapshotKeyByThreadRef.current.get(selectedThreadId) ?? null;
    if (lastSeededSnapshotKey !== snapshotKey) {
      return;
    }

    const nextToken = (autoBackfillRunTokenByThreadRef.current.get(selectedThreadId) ?? 0) + 1;
    autoBackfillRunTokenByThreadRef.current.set(selectedThreadId, nextToken);

    const runSequence = autoBackfillRequestCounterRef.current + 1;
    autoBackfillRequestCounterRef.current = runSequence;
    const cycleId = runSequence;
    const cyclePrefix = `auto-backfill-${selectedThreadId}-${runSequence}`;

    let cancelled = false;

    void (async () => {
      debugLog("useChatSession", "autoBackfill start", {
        threadId: selectedThreadId,
        cycleId,
        coverageEventsStatus: coverage.eventsStatus,
        coverageRecommendedBackfill: coverage.recommendedBackfill,
        timelineIncompleteCoverage: timelineHasIncompleteCoverage,
        initialBeforeIdx,
      });

      const outcome = await runAutoBackfillLoop({
        maxPages: AUTO_BACKFILL_MAX_PAGES,
        shouldAbort: () => {
          const activeToken = autoBackfillRunTokenByThreadRef.current.get(selectedThreadId) ?? 0;
          return cancelled || activeToken !== nextToken || activeThreadIdRef.current !== selectedThreadId;
        },
        isLoadingOlderHistory: () => loadingOlderHistoryRef.current,
        getBeforeIdx: () => nextBeforeIdxByThreadRef.current.get(selectedThreadId) ?? null,
        loadOlderHistoryPage: (pageNumber) => loadOlderHistory({
          cycleId,
          requestId: `${cyclePrefix}-page-${pageNumber}`,
        }),
        isTimelineIncomplete: () => timelineIncompleteCoverageRef.current,
      });

      debugLog("useChatSession", `autoBackfill stop ${outcome.stopReason}`, {
        threadId: selectedThreadId,
        cycleId,
        pagesLoaded: outcome.pagesLoaded,
      });

      debugLog("useChatSession", "autoBackfill end", {
        threadId: selectedThreadId,
        cycleId,
        pagesLoaded: outcome.pagesLoaded,
      });
    })();

    return () => {
      cancelled = true;
      const currentToken = autoBackfillRunTokenByThreadRef.current.get(selectedThreadId) ?? 0;
      if (currentToken === nextToken) {
        autoBackfillRunTokenByThreadRef.current.set(selectedThreadId, nextToken + 1);
      }
    };
  }, [queriedThreadSnapshot, selectedThreadId, timelineHasIncompleteCoverage]);

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
    hasOlderHistory,
    loadingOlderHistory,

    timelineItems,

    createAdditionalThread,
    createThreadAndSendMessage,
    closeThread,
    renameThreadTitle,
    submitMessage,
    loadOlderHistory,
    stopAssistantRun,

    startWaitingAssistant,
    clearWaitingAssistantForThread,
  };
}
