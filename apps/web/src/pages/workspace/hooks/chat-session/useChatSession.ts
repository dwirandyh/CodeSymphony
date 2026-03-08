import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ChatEvent,
  ChatMessage,
  ChatMode,
  ChatThread,
  AttachmentInput,
} from "@codesymphony/shared-types";
import { api } from "../../../../lib/api";
import { queryKeys } from "../../../../lib/queryKeys";
import { debugLog } from "../../../../lib/debugLog";
import { useThreads } from "../../../../hooks/queries/useThreads";
import { useThreadSnapshot } from "../../../../hooks/queries/useThreadSnapshot";
import { INITIAL_EVENTS_PAGE_LIMIT, INITIAL_MESSAGES_PAGE_LIMIT } from "../../constants";
import {
  detectSemanticBoundaryFromEvents,
  shouldClearWaitingAssistantOnEvent,
} from "../../eventUtils";
import { useWorkspaceTimeline, type TimelineRefs } from "../workspace-timeline";
import {
  derivePendingPermissionRequests,
  derivePendingPlan,
  derivePendingQuestionRequests,
  isRunCompletedAfterPlan,
} from "../worktreeThreadStatus";
import { pushRenderDebug } from "../../../../lib/renderDebug";
import type {
  LoadOlderHistoryRequestMetadata,
  LoadOlderHistoryResult,
  PendingMessageMutation,
  SemanticHydrationGateMetadata,
  UseChatSessionOptions,
} from "./useChatSession.types";
import {
  resolveHydrationBackfillPolicy,
  resolveSnapshotSeedDecision,
  buildAutoBackfillSnapshotKey,
  shouldInvalidateSnapshotImmediatelyAfterSubmit,
} from "./hydrationUtils";
import { prependUniqueMessages, prependUniqueEvents } from "./messageEventMerge";
import { applySnapshotSeed, applyThreadTitleUpdate } from "./snapshotSeed";
import { useThreadEventStream } from "./useThreadEventStream";
import { useAutoBackfill } from "./useAutoBackfill";

export function useChatSession(
  selectedWorktreeId: string | null,
  onError: (msg: string | null) => void,
  onBranchRenamed?: (worktreeId: string, newBranch: string) => void,
  options?: UseChatSessionOptions,
) {
  const queryClient = useQueryClient();
  const hydrationBackfillPolicy = resolveHydrationBackfillPolicy(options?.hydrationBackfillPolicy);
  const timelineEnabled = options?.timelineEnabled !== false;

  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<ChatEvent[]>([]);

  const [sendingMessage, setSendingMessage] = useState(false);
  const [stoppingThreadId, setStoppingThreadId] = useState<string | null>(null);
  const [stopRequestedThreadId, setStopRequestedThreadId] = useState<string | null>(null);
  const [closingThreadId, setClosingThreadId] = useState<string | null>(null);
  const [waitingAssistant, setWaitingAssistant] = useState<{ threadId: string; afterIdx: number } | null>(null);
  const [hasMoreOlderMessages, setHasMoreOlderMessages] = useState(false);
  const [hasMoreOlderEvents, setHasMoreOlderEvents] = useState(false);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const [semanticHydrationInProgress, setSemanticHydrationInProgress] = useState(false);

  const seenEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const lastEventIdxByThreadRef = useRef<Map<string, number>>(new Map());
  const nextBeforeSeqByThreadRef = useRef<Map<string, number | null>>(new Map());
  const nextBeforeIdxByThreadRef = useRef<Map<string, number | null>>(new Map());
  const streamingMessageIdsRef = useRef<Set<string>>(new Set());
  const stickyRawFallbackMessageIdsRef = useRef<Set<string>>(new Set());
  const renderDecisionByMessageIdRef = useRef<Map<string, string>>(new Map());
  const loggedOrphanEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const loggedFirstInsertOrderByMessageIdRef = useRef<Set<string>>(new Set());
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
  const loadingOlderHistoryRef = useRef(false);
  const autoBackfillRunTokenByThreadRef = useRef<Map<string, number>>(new Map());
  const autoBackfillRequestCounterRef = useRef(0);
  const semanticHydrationGateInFlightCountRef = useRef(0);
  const seededSnapshotKeyByThreadRef = useRef<Map<string, string>>(new Map());
  const lastAppliedSnapshotKeyByThreadRef = useRef<Map<string, string>>(new Map());
  const lastAutoBackfillLaunchKeyByThreadRef = useRef<Map<string, string>>(new Map());
  const autoBackfillInFlightLaunchKeyByThreadRef = useRef<Map<string, string>>(new Map());
  const autoBackfillLaunchCountByThreadRef = useRef<Map<string, number>>(new Map());
  const autoBackfillLaunchSnapshotKeyByThreadRef = useRef<Map<string, string>>(new Map());
  const autoBackfillLastLaunchConsumptionReasonByThreadRef = useRef<Map<string, "normal-stop" | "productive-abort">>(new Map());
  const autoBackfillEffectSignatureRef = useRef<{
    threadId: string;
    snapshotKey: string;
    timelineIncompleteCoverage: boolean;
  } | null>(null);

  loadingOlderHistoryRef.current = loadingOlderHistory;

  const updateSemanticHydrationGate = useCallback(
    (delta: 1 | -1, metadata: SemanticHydrationGateMetadata) => {
      const previousInFlightCount = semanticHydrationGateInFlightCountRef.current;
      const nextInFlightCount = Math.max(0, previousInFlightCount + delta);
      semanticHydrationGateInFlightCountRef.current = nextInFlightCount;
      debugLog(
        "useChatSession",
        delta > 0 ? "semanticHydrationGate open" : "semanticHydrationGate close",
        {
          ...metadata,
          previousInFlightCount,
          inFlightCount: nextInFlightCount,
        },
      );
      const nextActive = nextInFlightCount > 0;
      setSemanticHydrationInProgress((current) => {
        if (current === nextActive) {
          return current;
        }
        debugLog("useChatSession", "semanticHydrationGate state", {
          ...metadata,
          active: nextActive,
          inFlightCount: nextInFlightCount,
        });
        return nextActive;
      });
    },
    [],
  );

  const openSemanticHydrationGate = useCallback(
    (metadata: SemanticHydrationGateMetadata) => {
      updateSemanticHydrationGate(1, metadata);
    },
    [updateSemanticHydrationGate],
  );

  const closeSemanticHydrationGate = useCallback(
    (metadata: SemanticHydrationGateMetadata) => {
      updateSemanticHydrationGate(-1, metadata);
    },
    [updateSemanticHydrationGate],
  );

  const resetSemanticHydrationGate = useCallback((metadata: SemanticHydrationGateMetadata) => {
    const previousInFlightCount = semanticHydrationGateInFlightCountRef.current;
    semanticHydrationGateInFlightCountRef.current = 0;
    debugLog("useChatSession", "semanticHydrationGate reset", {
      ...metadata,
      previousInFlightCount,
      inFlightCount: 0,
    });
    setSemanticHydrationInProgress((current) => {
      if (!current) {
        return current;
      }
      debugLog("useChatSession", "semanticHydrationGate state", {
        ...metadata,
        active: false,
        inFlightCount: 0,
      });
      return false;
    });
  }, []);

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

    if (!selectedWorktreeId) {
      prevWorktreeIdRef2.current = selectedWorktreeId;
      setWaitingAssistant(null);
      setHasMoreOlderMessages(false);
      setHasMoreOlderEvents(false);
      loadingOlderHistoryRef.current = false;
      setLoadingOlderHistory(false);
      setThreads([]);
      setSelectedThreadId(null);
      setMessages([]);
      setEvents([]);
      return;
    }

    if (worktreeChanged) {
      setWaitingAssistant(null);
      setHasMoreOlderMessages(false);
      setHasMoreOlderEvents(false);
      loadingOlderHistoryRef.current = false;
      setLoadingOlderHistory(false);
      setMessages([]);
      setEvents([]);
    }

    if (!queriedThreads) return;

    prevWorktreeIdRef2.current = selectedWorktreeId;

    setThreads((current) => {
      if (current.length === queriedThreads.length && current.every((t, i) => t.id === queriedThreads[i].id && t.title === queriedThreads[i].title && t.claudeSessionId === queriedThreads[i].claudeSessionId && t.active === queriedThreads[i].active && t.updatedAt === queriedThreads[i].updatedAt)) {
        return current;
      }
      return queriedThreads;
    });

    if (queriedThreads.length > 0) {
      const selectedThreadStillExists =
        selectedThreadId != null && queriedThreads.some((thread) => thread.id === selectedThreadId);

      if (selectedThreadStillExists) {
        debugLog("useChatSession", "consolidated thread-sync selection", {
          reason: "keep-selected-thread",
          selectedThreadId,
        });
        return;
      }

      let nextThreadId = queriedThreads[0].id;
      let selectionReason: "apply-initial-thread" | "select-first-thread" | "reconcile-missing-thread" =
        selectedThreadId == null ? "select-first-thread" : "reconcile-missing-thread";

      if (!initialThreadAppliedRef.current) {
        initialThreadAppliedRef.current = true;
        if (options?.initialThreadId) {
          const match = queriedThreads.find((thread) => thread.id === options.initialThreadId);
          if (match) {
            nextThreadId = match.id;
            selectionReason = "apply-initial-thread";
          }
        }
      }

      if (selectedThreadId !== nextThreadId) {
        debugLog("useChatSession", "consolidated thread-sync selection", {
          reason: selectionReason,
          selectedThreadId,
          nextThreadId,
          initialThreadId: options?.initialThreadId ?? null,
        });
        setSelectedThreadId(nextThreadId);
      }
    } else {
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
  useEffect(() => {
    if (!selectedThreadId) return;
    if (restoredActiveThreadIdsRef.current.has(selectedThreadId)) return;

    const thread = threads.find((t) => t.id === selectedThreadId);
    if (thread?.active) {
      restoredActiveThreadIdsRef.current.add(selectedThreadId);
      startWaitingAssistant(selectedThreadId);
    }
  }, [selectedThreadId, threads]);

  const hasPendingPermissionRequests = derivePendingPermissionRequests(events).length > 0;
  const hasPendingQuestionRequests = derivePendingQuestionRequests(events).length > 0;
  const pendingPlan = derivePendingPlan(events);
  const hasPendingPlan = pendingPlan?.status === "pending" && isRunCompletedAfterPlan(events, pendingPlan);
  const hasPendingUserGate = hasPendingPermissionRequests || hasPendingQuestionRequests || hasPendingPlan;

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
    const lastAppliedSnapshotKey = selectedThreadId
      ? lastAppliedSnapshotKeyByThreadRef.current.get(selectedThreadId) ?? null
      : null;
    const previousSeededSnapshotKey = selectedThreadId
      ? seededSnapshotKeyByThreadRef.current.get(selectedThreadId) ?? null
      : null;
    const localLatestEventIdx = selectedThreadId
      ? lastEventIdxByThreadRef.current.get(selectedThreadId) ?? null
      : null;
    const seedDecision = resolveSnapshotSeedDecision({
      selectedThreadId,
      queriedThreadSnapshot,
      threadChanged,
      lastAppliedSnapshotKey,
      localLatestEventIdx,
      hasPendingUserGate: !threadChanged && activeThreadIdRef.current === selectedThreadId && hasPendingUserGate,
    });
    debugLog("useChatSession", "seed snapshot effect", {
      selectedThreadId,
      threadChanged,
      queriedMessagesLength: queriedThreadSnapshot?.messages.data.length ?? null,
      queriedEventsLength: queriedThreadSnapshot?.events.data.length ?? null,
      snapshotKey: seedDecision.snapshotKey,
      lastAppliedSnapshotKey,
      previousSeededSnapshotKey,
      seedReason: seedDecision.reason,
      shouldApplySnapshot: seedDecision.shouldApply,
      newestEventIdx: queriedThreadSnapshot?.watermarks.newestIdx ?? null,
      newestMessageSeq: queriedThreadSnapshot?.watermarks.newestSeq ?? null,
      currentLocalMessagesLength: messages.length,
      currentLocalEventsLength: events.length,
      localLatestEventIdx,
      hasPendingUserGate,
    });

    if (threadChanged) {
      prevSeedThreadRef.current = selectedThreadId;
    }

    if (!selectedThreadId) {
      debugLog("useChatSession", "seed snapshot skipped", {
        selectedThreadId,
        reason: "no-thread-or-snapshot",
        snapshotKey: seedDecision.snapshotKey,
      });
      if (messages.length > 0) {
        setMessages([]);
      }
      if (events.length > 0) {
        setEvents([]);
      }
      return;
    }

    if (!queriedThreadSnapshot || seedDecision.snapshotKey == null) {
      if (threadChanged) {
        seededSnapshotKeyByThreadRef.current.delete(selectedThreadId);
        lastAppliedSnapshotKeyByThreadRef.current.delete(selectedThreadId);
        debugLog("useChatSession", "seed snapshot skipped", {
          selectedThreadId,
          reason: "no-thread-or-snapshot-thread-changed",
          snapshotKey: seedDecision.snapshotKey,
        });
        setMessages([]);
        setEvents([]);
      } else {
        debugLog("useChatSession", "seed snapshot skipped", {
          selectedThreadId,
          reason: "no-thread-or-snapshot-preserve-current-thread",
          snapshotKey: seedDecision.snapshotKey,
        });
      }
      return;
    }

    if (!seedDecision.shouldApply) {
      seededSnapshotKeyByThreadRef.current.set(selectedThreadId, seedDecision.snapshotKey);
      debugLog("useChatSession", "seed snapshot skipped", {
        selectedThreadId,
        reason: seedDecision.reason,
        snapshotKey: seedDecision.snapshotKey,
        localLastEventIdxAfterDecision: selectedThreadId
          ? lastEventIdxByThreadRef.current.get(selectedThreadId) ?? null
          : null,
        localSeenEventCount: selectedThreadId
          ? seenEventIdsByThreadRef.current.get(selectedThreadId)?.size ?? 0
          : 0,
        nextBeforeIdxLocal: selectedThreadId
          ? nextBeforeIdxByThreadRef.current.get(selectedThreadId) ?? null
          : null,
      });
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
      mode: threadChanged ? "replace" : "merge",
    });
    seededSnapshotKeyByThreadRef.current.set(selectedThreadId, seedDecision.snapshotKey);
    lastAppliedSnapshotKeyByThreadRef.current.set(selectedThreadId, seedDecision.snapshotKey);
    debugLog("useChatSession", "seed snapshot applied", {
      selectedThreadId,
      reason: seedDecision.reason,
      snapshotKey: seedDecision.snapshotKey,
      previousSnapshotKey: lastAppliedSnapshotKey,
      previousSeededSnapshotKey,
      appliedMessagesLength: queriedThreadSnapshot.messages.data.length,
      appliedEventsLength: queriedThreadSnapshot.events.data.length,
    });
  }, [hasPendingUserGate, messages.length, onBranchRenamed, queriedThreadSnapshot, selectedThreadId, selectedWorktreeId]);

  useEffect(() => {
    if (!selectedThreadId) {
      seededSnapshotKeyByThreadRef.current.clear();
      lastAppliedSnapshotKeyByThreadRef.current.clear();
      autoBackfillRunTokenByThreadRef.current.clear();
      lastAutoBackfillLaunchKeyByThreadRef.current.clear();
      autoBackfillInFlightLaunchKeyByThreadRef.current.clear();
      autoBackfillLaunchCountByThreadRef.current.clear();
      autoBackfillLaunchSnapshotKeyByThreadRef.current.clear();
      autoBackfillLastLaunchConsumptionReasonByThreadRef.current.clear();
      autoBackfillEffectSignatureRef.current = null;
      resetSemanticHydrationGate({
        threadId: null,
        reason: "thread-cleared",
      });
      return;
    }

    return () => {
      clearThreadTrackingState(selectedThreadId);
      resetSemanticHydrationGate({
        threadId: selectedThreadId,
        reason: "thread-switched",
      });
    };
  }, [selectedThreadId, resetSemanticHydrationGate]);

  function clearThreadTrackingState(threadId: string) {
    seenEventIdsByThreadRef.current.delete(threadId);
    lastEventIdxByThreadRef.current.delete(threadId);
    nextBeforeSeqByThreadRef.current.delete(threadId);
    nextBeforeIdxByThreadRef.current.delete(threadId);
    loggedOrphanEventIdsByThreadRef.current.delete(threadId);
    seededSnapshotKeyByThreadRef.current.delete(threadId);
    lastAppliedSnapshotKeyByThreadRef.current.delete(threadId);
    autoBackfillRunTokenByThreadRef.current.delete(threadId);
    lastAutoBackfillLaunchKeyByThreadRef.current.delete(threadId);
    autoBackfillInFlightLaunchKeyByThreadRef.current.delete(threadId);
    autoBackfillLaunchCountByThreadRef.current.delete(threadId);
    autoBackfillLaunchSnapshotKeyByThreadRef.current.delete(threadId);
    autoBackfillLastLaunchConsumptionReasonByThreadRef.current.delete(threadId);
  }

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
  useThreadEventStream({
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
  });

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

  async function createThreadAndSendMessage(title: string, content: string, mode: ChatMode = "default") {
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
        await api.sendMessage(created.id, { content, mode, attachments: [] });
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
      clearThreadTrackingState(threadId);
      if (seenEventIdsByThreadRef.current.size > 10) {
        const activeThreadIds = new Set(threads.map(t => t.id));
        for (const key of [...seenEventIdsByThreadRef.current.keys()]) {
          if (!activeThreadIds.has(key)) {
            clearThreadTrackingState(key);
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

  async function submitMessage(
    content: string,
    mode: ChatMode,
    messageAttachments: Array<AttachmentInput & { sizeBytes?: number; isInline?: boolean }>,
  ) {
    const shouldInvalidateSnapshot = shouldInvalidateSnapshotImmediatelyAfterSubmit();
    const attachmentsToSend: AttachmentInput[] = messageAttachments.map((att) => ({
      id: att.id,
      filename: att.filename,
      mimeType: att.mimeType,
      content: att.content,
      source: att.source,
    }));

    if (!selectedThreadId || (!content.trim() && attachmentsToSend.length === 0)) return false;

    debugLog("useChatSession", "submitMessage start", {
      selectedThreadId,
      contentLength: content.length,
      attachmentsCount: attachmentsToSend.length,
      mode,
    });
    startWaitingAssistant(selectedThreadId);
    setSendingMessage(true);
    onError(null);

    try {
      await api.sendMessage(selectedThreadId, { content, mode, attachments: attachmentsToSend });
      debugLog("useChatSession", "submitMessage ack", {
        selectedThreadId,
        shouldInvalidateSnapshot,
      });
      if (shouldInvalidateSnapshot) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.threads.snapshot(selectedThreadId) });
      }
      return true;
    } catch (e) {
      debugLog("useChatSession", "submitMessage failed", {
        selectedThreadId,
        error: e instanceof Error ? e.message : String(e),
      });
      setWaitingAssistant(null);
      onError(e instanceof Error ? e.message : "Failed to send message");
      return false;
    } finally {
      debugLog("useChatSession", "submitMessage end", { selectedThreadId });
      setSendingMessage(false);
    }
  }

  const timelineMessageCount = messages.length;
  const timelineEventCount = events.length;
  const loadOlderHistory = useCallback(async (metadata?: LoadOlderHistoryRequestMetadata): Promise<LoadOlderHistoryResult | void> => {
    if (!selectedThreadId) return;

    if (loadingOlderHistoryRef.current) {
      debugLog("useChatSession", "chat.pagination.skipped", {
        threadId: selectedThreadId,
        cycleId: metadata?.cycleId ?? null,
        requestId: metadata?.requestId ?? null,
        source: metadata?.source ?? "manual",
        skipReason: "reentry",
        localMessageCount: timelineMessageCount,
        localEventCount: timelineEventCount,
      });
      return;
    }

    const threadId = selectedThreadId;
    const beforeSeq = nextBeforeSeqByThreadRef.current.get(threadId) ?? null;
    const beforeIdx = nextBeforeIdxByThreadRef.current.get(threadId) ?? null;
    const requestNumber = loadOlderRequestCounterRef.current + 1;
    loadOlderRequestCounterRef.current = requestNumber;
    const cycleId = metadata?.cycleId ?? null;
    const requestId = metadata?.requestId ?? `load-older-${threadId}-${requestNumber}`;
    const source = metadata?.source ?? "manual";
    const eventsLimit = metadata?.eventsLimitOverride ?? INITIAL_EVENTS_PAGE_LIMIT;
    const loadStartedAt = performance.now();

    if (beforeSeq == null && beforeIdx == null) {
      setHasMoreOlderMessages(false);
      setHasMoreOlderEvents(false);
      debugLog("useChatSession", "chat.pagination.skipped", {
        threadId,
        cycleId,
        requestId,
        source,
        skipReason: "empty-cursors",
        beforeSeq,
        beforeIdx,
        localMessageCount: timelineMessageCount,
        localEventCount: timelineEventCount,
      });
      return {
        cycleId,
        requestId,
        completionReason: "empty-cursors",
        messagesAdded: 0,
        eventsAdded: 0,
        estimatedRenderableGrowth: false,
        source,
        semanticBoundaryDetected: false,
        semanticBoundary: null,
      };
    }

    const semanticHydrationGateMetadata: SemanticHydrationGateMetadata = {
      threadId,
      reason: "load-older-history",
      source,
      cycleId,
      requestId,
    };

    openSemanticHydrationGate(semanticHydrationGateMetadata);
    loadingOlderHistoryRef.current = true;
    setLoadingOlderHistory(true);
    onError(null);
    debugLog("useChatSession", "chat.pagination.requested", {
      threadId,
      beforeSeq,
      beforeIdx,
      cycleId,
      requestId,
      source,
      eventsLimit,
      localMessageCount: timelineMessageCount,
      localEventCount: timelineEventCount,
    });

    try {
      const [messagesPage, eventsPage] = await Promise.all([
        beforeSeq == null
          ? Promise.resolve<import("@codesymphony/shared-types").ChatMessagesPage | null>(null)
          : api.listMessagesPage(threadId, {
            beforeSeq,
            limit: INITIAL_MESSAGES_PAGE_LIMIT,
          }),
        beforeIdx == null
          ? Promise.resolve<import("@codesymphony/shared-types").ChatEventsPage | null>(null)
          : api.listEventsPage(threadId, {
            beforeIdx,
            limit: eventsLimit,
          }),
      ]);

      const semanticBoundary = eventsPage
        ? detectSemanticBoundaryFromEvents(eventsPage.data)
        : null;
      const semanticBoundaryDetected = semanticBoundary != null;
      const responseKind = messagesPage && eventsPage
        ? messagesPage.data.length > 0 && eventsPage.data.length > 0
          ? "both"
          : messagesPage.data.length > 0
            ? "messages-only"
            : eventsPage.data.length > 0
              ? "events-only"
              : "empty"
        : messagesPage
          ? messagesPage.data.length > 0
            ? "messages-only"
            : "empty"
          : eventsPage
            ? eventsPage.data.length > 0
              ? "events-only"
              : "empty"
            : "empty";

      if (selectedThreadId !== threadId) {
        debugLog("useChatSession", "chat.pagination.skipped", {
          threadId,
          selectedThreadId,
          cycleId,
          requestId,
          source,
          skipReason: "thread-changed",
          beforeSeq,
          beforeIdx,
          responseKind,
          localMessageCount: timelineMessageCount,
          localEventCount: timelineEventCount,
        });
        return {
          cycleId,
          requestId,
          completionReason: "thread-changed",
          messagesAdded: 0,
          eventsAdded: 0,
          estimatedRenderableGrowth: false,
          source,
          semanticBoundaryDetected,
          semanticBoundary,
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

      debugLog("useChatSession", "chat.pagination.response", {
        threadId,
        cycleId,
        requestId,
        source,
        beforeSeq,
        beforeIdx,
        eventsLimit,
        responseKind,
        messagesAdded,
        eventsAdded,
        nextBeforeSeq: messagesPage?.pageInfo.nextBeforeSeq ?? null,
        nextBeforeIdx: eventsPage?.pageInfo.nextBeforeIdx ?? null,
        hasMoreOlderMessages: messagesPage?.pageInfo.hasMoreOlder ?? false,
        hasMoreOlderEvents: eventsPage?.pageInfo.hasMoreOlder ?? false,
        messageSeqRange: messagesPage && messagesPage.data.length > 0
          ? {
            oldest: messagesPage.data[0]?.seq ?? null,
            newest: messagesPage.data[messagesPage.data.length - 1]?.seq ?? null,
          }
          : null,
        eventIdxRange: eventsPage && eventsPage.data.length > 0
          ? {
            oldest: eventsPage.data[0]?.idx ?? null,
            newest: eventsPage.data[eventsPage.data.length - 1]?.idx ?? null,
          }
          : null,
        semanticBoundaryDetected,
        semanticBoundaryKind: semanticBoundary?.kind ?? null,
        semanticBoundaryEventId: semanticBoundary?.eventId ?? null,
        semanticBoundaryEventIdx: semanticBoundary?.eventIdx ?? null,
        semanticBoundaryEventType: semanticBoundary?.eventType ?? null,
        durationMs: Number((performance.now() - loadStartedAt).toFixed(2)),
        localMessageCountBeforeApply: timelineMessageCount,
        localEventCountBeforeApply: timelineEventCount,
      });

      if (messagesPage) {
        setMessages((current) => prependUniqueMessages(current, messagesPage.data));
      }
      if (eventsPage) {
        setEvents((current) => prependUniqueEvents(current, eventsPage.data));
      }

      debugLog("useChatSession", "chat.pagination.applied", {
        threadId,
        cycleId,
        requestId,
        source,
        completionReason: "applied",
        responseKind,
        messagesAdded,
        eventsAdded,
        nextBeforeSeq: nextBeforeSeqByThreadRef.current.get(threadId) ?? null,
        nextBeforeIdx: nextBeforeIdxByThreadRef.current.get(threadId) ?? null,
        localMessageCountBeforeApply: timelineMessageCount,
        localEventCountBeforeApply: timelineEventCount,
        localMessageCountAfterApply: timelineMessageCount + messagesAdded,
        localEventCountAfterApply: timelineEventCount + eventsAdded,
      });

      return {
        cycleId,
        requestId,
        completionReason: "applied",
        messagesAdded,
        eventsAdded,
        estimatedRenderableGrowth: messagesAdded > 0 || eventsAdded > 0,
        source,
        semanticBoundaryDetected,
        semanticBoundary,
      };
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load older history");
      throw e;
    } finally {
      debugLog("useChatSession", "chat.pagination.completed", {
        threadId,
        cycleId,
        requestId,
        source,
        loadingOlderHistory: false,
      });
      loadingOlderHistoryRef.current = false;
      setLoadingOlderHistory(false);
      closeSemanticHydrationGate(semanticHydrationGateMetadata);
    }
  }, [
    closeSemanticHydrationGate,
    onError,
    openSemanticHydrationGate,
    selectedThreadId,
    timelineEventCount,
    timelineMessageCount,
  ]);

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
    loggedFirstInsertOrderByMessageId: loggedFirstInsertOrderByMessageIdRef.current,
  });
  timelineRefsRef.current.streamingMessageIds = streamingMessageIdsRef.current;
  timelineRefsRef.current.stickyRawFallbackMessageIds = stickyRawFallbackMessageIdsRef.current;
  timelineRefsRef.current.renderDecisionByMessageId = renderDecisionByMessageIdRef.current;
  timelineRefsRef.current.loggedOrphanEventIdsByThread = loggedOrphanEventIdsByThreadRef.current;
  timelineRefsRef.current.loggedFirstInsertOrderByMessageId = loggedFirstInsertOrderByMessageIdRef.current;

  const {
    items: timelineItems,
    hasIncompleteCoverage: timelineHasIncompleteCoverage,
    summary: timelineSummary,
  } = useWorkspaceTimeline(messages, events, selectedThreadId, timelineRefsRef.current, {
    semanticHydrationInProgress,
    disabled: !timelineEnabled,
  });

  const timelineIncompleteCoverageRef = useRef(false);
  timelineIncompleteCoverageRef.current = timelineHasIncompleteCoverage;

  const loadOlderHistoryFnRef = useRef(loadOlderHistory);
  loadOlderHistoryFnRef.current = loadOlderHistory;

  // ── Auto-backfill ──
  useAutoBackfill({
    selectedThreadId,
    queriedThreadSnapshot,
    hydrationBackfillPolicy,
    timelineHasIncompleteCoverage,
    hasPendingUserGate,
    loadingOlderHistoryRef,
    activeThreadIdRef,
    nextBeforeIdxByThreadRef,
    seededSnapshotKeyByThreadRef,
    lastAppliedSnapshotKeyByThreadRef,
    autoBackfillRunTokenByThreadRef,
    autoBackfillRequestCounterRef,
    lastAutoBackfillLaunchKeyByThreadRef,
    autoBackfillInFlightLaunchKeyByThreadRef,
    autoBackfillLaunchCountByThreadRef,
    autoBackfillLaunchSnapshotKeyByThreadRef,
    autoBackfillLastLaunchConsumptionReasonByThreadRef,
    autoBackfillEffectSignatureRef,
    timelineIncompleteCoverageRef,
    loadOlderHistoryFnRef,
    openSemanticHydrationGate,
    closeSemanticHydrationGate,
  });

  return {
    threads,
    selectedThreadId,
    setSelectedThreadId,
    messages,
    events,
    closingThreadId,

    sendingMessage,
    waitingAssistant,
    showStopAction,
    stoppingRun,
    hasOlderHistory,
    loadingOlderHistory,
    semanticHydrationInProgress,

    timelineItems,
    timelineSummary,

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
