import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  AttachmentInput,
  ChatEvent,
  ChatMessage,
  ChatMode,
  ChatThread,
  ChatTimelineItem,
  ChatTimelineSummary,
} from "@codesymphony/shared-types";
import { api } from "../../../../lib/api";
import { pushRenderDebug } from "../../../../lib/renderDebug";
import { queryKeys } from "../../../../lib/queryKeys";
import { useThreads } from "../../../../hooks/queries/useThreads";
import { useThreadSnapshot } from "../../../../hooks/queries/useThreadSnapshot";
import {
  shouldClearWaitingAssistantOnEvent,
} from "../../eventUtils";
import { useWorkspaceTimeline } from "../workspace-timeline";
import {
  derivePendingPermissionRequests,
  derivePendingPlan,
  derivePendingQuestionRequests,
  deriveThreadUiStatusFromEvents,
  isRunCompletedAfterPlan,
  type WorktreeThreadUiStatus,
} from "../worktreeThreadStatus";
import type {
  PendingMessageMutation,
  UseChatSessionOptions,
} from "./useChatSession.types";
import {
  resolveSnapshotSeedDecision,
  buildSnapshotKey,
  shouldInvalidateSnapshotImmediatelyAfterSubmit,
} from "./hydrationUtils";
import { prependUniqueMessages, prependUniqueEvents } from "./messageEventMerge";
import { applySnapshotSeed, applyThreadModeUpdate, applyThreadTitleUpdate } from "./snapshotSeed";
import { useThreadEventStream } from "./useThreadEventStream";

function resolvePreferredThreadId(threads: ChatThread[]): string | null {
  for (let index = threads.length - 1; index >= 0; index -= 1) {
    if (threads[index]?.active) {
      return threads[index].id;
    }
  }

  return threads[threads.length - 1]?.id ?? null;
}

function findThreadForWorktree(
  threads: ChatThread[],
  threadId: string | null,
  worktreeId: string | null,
): ChatThread | null {
  if (!threadId || !worktreeId) {
    return null;
  }

  const thread = threads.find((candidate) => candidate.id === threadId) ?? null;
  if (!thread || thread.worktreeId !== worktreeId) {
    return null;
  }

  return thread;
}

function summarizeTimelineItems(items: ChatTimelineItem[]): {
  total: number;
  signatures: string[];
  kinds: Record<string, number>;
  exploreCards: number;
  emptyExploreCards: number;
  subagentCards: number;
  subagentsMissingDescription: number;
} {
  const kinds: Record<string, number> = {};
  const signatures: string[] = [];
  let exploreCards = 0;
  let emptyExploreCards = 0;
  let subagentCards = 0;
  let subagentsMissingDescription = 0;

  for (const item of items) {
    kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;

    if (item.kind === "explore-activity") {
      exploreCards += 1;
      if ((item.entries?.length ?? 0) === 0) {
        emptyExploreCards += 1;
      }
      signatures.push(`explore:${item.id}:${item.status}:${item.entries?.length ?? 0}`);
      continue;
    }

    if (item.kind === "subagent-activity") {
      subagentCards += 1;
      if (item.description.trim().length === 0) {
        subagentsMissingDescription += 1;
      }
      signatures.push(
        `subagent:${item.id}:${item.status}:${item.steps.length}:${item.description.trim().length}:${item.lastMessage?.length ?? 0}`,
      );
      continue;
    }

    if (item.kind === "message") {
      signatures.push(`message:${item.message.id}:${item.message.role}:${item.message.content.length}`);
      continue;
    }

    if (item.kind === "tool") {
      signatures.push(`tool:${item.id}:${item.toolName ?? ""}:${item.status ?? ""}`);
      continue;
    }

    signatures.push(`${item.kind}:${"id" in item ? String(item.id) : ""}`);
  }

  return {
    total: items.length,
    signatures,
    kinds,
    exploreCards,
    emptyExploreCards,
    subagentCards,
    subagentsMissingDescription,
  };
}

export function deriveSelectedThreadUiState(params: {
  selectedThreadId: string | null;
  threads: ChatThread[];
  events: ChatEvent[];
  sendingMessage: boolean;
  waitingAssistant: { threadId: string; afterIdx: number } | null;
}): { selectedThreadUiStatus: WorktreeThreadUiStatus; composerDisabled: boolean } {
  const { selectedThreadId, threads, events, sendingMessage, waitingAssistant } = params;
  const selectedThread = selectedThreadId
    ? threads.find((thread) => thread.id === selectedThreadId) ?? null
    : null;
  const optimisticThreadRunning =
    selectedThreadId != null
    && (sendingMessage || waitingAssistant?.threadId === selectedThreadId);
  const selectedThreadUiStatus = deriveThreadUiStatusFromEvents(
    events,
    Boolean(selectedThread?.active) || optimisticThreadRunning,
  );

  return {
    selectedThreadUiStatus,
    composerDisabled: !selectedThreadId || sendingMessage,
  };
}

export function useChatSession(
  selectedWorktreeId: string | null,
  onError: (msg: string | null) => void,
  onBranchRenamed?: (worktreeId: string, newBranch: string) => void,
  options?: UseChatSessionOptions,
) {
  const queryClient = useQueryClient();
  const repositoryId = options?.repositoryId ?? null;
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

  const seenEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const lastEventIdxByThreadRef = useRef<Map<string, number>>(new Map());
  const streamingMessageIdsRef = useRef<Set<string>>(new Set());
  const stickyRawFallbackMessageIdsRef = useRef<Set<string>>(new Set());
  const renderDecisionByMessageIdRef = useRef<Map<string, string>>(new Map());
  const loggedOrphanEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const claimedContextEventIdsByThreadMessageRef = useRef<Map<string, Set<string>>>(new Map());
  const activeThreadIdRef = useRef<string | null>(null);
  const creatingThreadRef = useRef(false);
  const optimisticCreatedThreadIdsRef = useRef<Set<string>>(new Set());
  const prevThreadIdRef = useRef<string | null>(null);
  const prevSeedThreadRef = useRef<string | null>(null);
  const prevRequestedThreadIdRef = useRef<string | null>(null);
  const restoredActiveThreadIdsRef = useRef<Set<string>>(new Set());
  const pendingEventsRef = useRef<ChatEvent[]>([]);
  const pendingMessageMutationsRef = useRef<PendingMessageMutation[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const lastAppliedSnapshotKeyByThreadRef = useRef<Map<string, string>>(new Map());

  activeThreadIdRef.current = selectedThreadId;

  const { data: queriedThreads } = useThreads(selectedWorktreeId);

  const prevWorktreeIdRef2 = useRef<string | null>(selectedWorktreeId);

  useEffect(() => {
    const worktreeChanged = selectedWorktreeId !== prevWorktreeIdRef2.current;

    if (!selectedWorktreeId) {
      prevWorktreeIdRef2.current = selectedWorktreeId;
      setWaitingAssistant(null);
      setThreads([]);
      setSelectedThreadId(null);
      setMessages([]);
      setEvents([]);
      return;
    }

    if (worktreeChanged) {
      setWaitingAssistant(null);
      setThreads([]);
      setSelectedThreadId(null);
      setMessages([]);
      setEvents([]);
    }

    if (!queriedThreads) return;

    prevWorktreeIdRef2.current = selectedWorktreeId;

    setThreads((current) => {
      const optimisticCreatedThreadIds = optimisticCreatedThreadIdsRef.current;
      const optimisticThreads = current.filter((thread) => optimisticCreatedThreadIds.has(thread.id));
      const mergedThreads = [...queriedThreads];
      for (const optimisticThread of optimisticThreads) {
        if (!mergedThreads.some((thread) => thread.id === optimisticThread.id)) {
          mergedThreads.push(optimisticThread);
        }
      }

      if (current.length === mergedThreads.length && current.every((t, i) => t.id === mergedThreads[i].id && t.title === mergedThreads[i].title && t.mode === mergedThreads[i].mode && t.claudeSessionId === mergedThreads[i].claudeSessionId && t.active === mergedThreads[i].active && t.updatedAt === mergedThreads[i].updatedAt)) {
        return current;
      }
      return mergedThreads;
    });

    const requestedThreadId = options?.desiredThreadId ?? null;
    const requestedThreadIdChanged = prevRequestedThreadIdRef.current !== requestedThreadId;

    if (requestedThreadIdChanged) {
      prevRequestedThreadIdRef.current = requestedThreadId;
    }

    if (queriedThreads.length > 0) {
      if (requestedThreadIdChanged) {
        const nextThreadId = requestedThreadId != null
          ? queriedThreads.find((thread) => thread.id === requestedThreadId)?.id ?? resolvePreferredThreadId(queriedThreads)
          : resolvePreferredThreadId(queriedThreads);

        if (selectedThreadId !== nextThreadId) {
          setSelectedThreadId(nextThreadId);
        }
        return;
      }

      const selectedThreadStillExists =
        selectedThreadId != null && queriedThreads.some((thread) => thread.id === selectedThreadId);

      if (selectedThreadStillExists) return;

      const nextThreadId = resolvePreferredThreadId(queriedThreads);
      if (selectedThreadId !== nextThreadId) {
        setSelectedThreadId(nextThreadId);
      }
    } else {
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
  }, [options?.desiredThreadId, queriedThreads, selectedThreadId, selectedWorktreeId]);

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
  const { selectedThreadUiStatus, composerDisabled } = deriveSelectedThreadUiState({
    selectedThreadId,
    threads,
    events,
    sendingMessage,
    waitingAssistant,
  });
  const selectedThreadIsRunning = selectedThreadUiStatus === "running";
  const selectedThread = selectedThreadId
    ? threads.find((thread) => thread.id === selectedThreadId) ?? null
    : null;
  const composerMode = selectedThreadUiStatus === "review_plan"
    ? "plan"
    : selectedThread?.mode ?? "default";
  const composerModeLocked = selectedThreadUiStatus !== "idle";
  const selectedThreadIsPrMr = !!selectedThreadId && threads.some(
    (thread) => thread.id === selectedThreadId && thread.kind === "review",
  );

  const { data: queriedThreadSnapshot } = useThreadSnapshot(selectedThreadId);

  useEffect(() => {
    const threadChanged = prevSeedThreadRef.current !== selectedThreadId;
    const lastAppliedSnapshotKey = selectedThreadId
      ? lastAppliedSnapshotKeyByThreadRef.current.get(selectedThreadId) ?? null
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

    if (threadChanged) {
      prevSeedThreadRef.current = selectedThreadId;
    }

    if (!selectedThreadId) {
      if (messages.length > 0) setMessages([]);
      if (events.length > 0) setEvents([]);
      return;
    }

    if (!queriedThreadSnapshot || seedDecision.snapshotKey == null) {
      if (threadChanged) {
        lastAppliedSnapshotKeyByThreadRef.current.delete(selectedThreadId);
        setMessages([]);
        setEvents([]);
      }
      return;
    }

    if (!seedDecision.shouldApply) {
      return;
    }

    applySnapshotSeed({
      snapshot: queriedThreadSnapshot,
      selectedThreadId,
      selectedWorktreeId,
      setMessages,
      setEvents,
      setThreads,
      seenEventIdsByThreadRef,
      lastEventIdxByThreadRef,
      activeThreadIdRef,
      onBranchRenamed,
      mode: threadChanged ? "replace" : "merge",
    });
    lastAppliedSnapshotKeyByThreadRef.current.set(selectedThreadId, seedDecision.snapshotKey);
  }, [hasPendingUserGate, messages.length, onBranchRenamed, queriedThreadSnapshot, selectedThreadId, selectedWorktreeId]);

  useEffect(() => {
    if (!selectedThreadId) {
      lastAppliedSnapshotKeyByThreadRef.current.clear();
      return;
    }

    return () => {
      clearThreadTrackingState(selectedThreadId);
    };
  }, [selectedThreadId]);

  function clearThreadTrackingState(threadId: string) {
    seenEventIdsByThreadRef.current.delete(threadId);
    lastEventIdxByThreadRef.current.delete(threadId);
    loggedOrphanEventIdsByThreadRef.current.delete(threadId);
    const claimedKeyPrefix = `${threadId}:`;
    for (const key of claimedContextEventIdsByThreadMessageRef.current.keys()) {
      if (key.startsWith(claimedKeyPrefix)) {
        claimedContextEventIdsByThreadMessageRef.current.delete(key);
      }
    }
    lastAppliedSnapshotKeyByThreadRef.current.delete(threadId);
  }

  function startWaitingAssistant(threadId: string) {
    const afterIdx = lastEventIdxByThreadRef.current.get(threadId) ?? -1;
    setWaitingAssistant({ threadId, afterIdx });
  }

  function clearWaitingAssistantForThread(threadId: string) {
    setWaitingAssistant((current) => (current?.threadId === threadId ? null : current));
  }

  function invalidateRepositoryReviews() {
    if (!repositoryId) {
      return;
    }

    void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.reviews(repositoryId) });
  }

  useEffect(() => {
    const willNotify = prevThreadIdRef.current !== selectedThreadId;
    if (willNotify) {
      prevThreadIdRef.current = selectedThreadId;
      options?.onThreadChange?.(selectedThreadId);
    }
  }, [selectedThreadId]);

  useThreadEventStream({
    selectedThreadId,
    selectedWorktreeId,
    repositoryId,
    selectedThreadIsPrMr,
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
  });

  useEffect(() => {
    if (!selectedThreadId) return;

    setWaitingAssistant((current) => {
      if (!current || current.threadId !== selectedThreadId) return current;
      const matchedEvent = events.find(
        (event) => event.idx > current.afterIdx && shouldClearWaitingAssistantOnEvent(event),
      );
      if (matchedEvent) {
        return null;
      }
      return current;
    });
  }, [events, selectedThreadId]);

  async function createThreadInCurrentContext(title: string): Promise<{ created: ChatThread; worktreeId: string } | null> {
    if (!selectedWorktreeId) {
      return null;
    }

    const created = await api.createThread(selectedWorktreeId, { title });
    return { created, worktreeId: selectedWorktreeId };
  }

  async function createAdditionalThread() {
    onError(null);
    try {
      const result = await createThreadInCurrentContext(`Thread ${threads.length + 1}`);
      if (!result) return null;
      const { created, worktreeId } = result;
      optimisticCreatedThreadIdsRef.current.add(created.id);
      setThreads((current) => {
        if (current.some((t) => t.id === created.id)) return current;
        return [...current, created];
      });
      setSelectedThreadId(created.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(worktreeId) });
      return created;
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create thread");
      return null;
    }
  }

  async function createThreadAndSendMessage(title: string, content: string, mode: ChatMode = "default") {
    onError(null);
    try {
      const result = await createThreadInCurrentContext(title);
      if (!result) return;
      const { created, worktreeId } = result;
      optimisticCreatedThreadIdsRef.current.add(created.id);
      setThreads((current) => {
        if (current.some((t) => t.id === created.id)) return current;
        return [...current, created];
      });
      setSelectedThreadId(created.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(worktreeId) });
      startWaitingAssistant(created.id);
      setSendingMessage(true);
      try {
        setThreads((current) => applyThreadModeUpdate(current, created.id, mode));
        queryClient.setQueryData<ChatThread[] | undefined>(
          queryKeys.threads.list(worktreeId),
          (current) => current ? applyThreadModeUpdate(current, created.id, mode) : current,
        );
        await api.sendMessage(created.id, {
          content,
          mode,
          attachments: [],
          expectedWorktreeId: worktreeId,
        });
      } catch (e) {
        setWaitingAssistant(null);
        throw e;
      } finally {
        setSendingMessage(false);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create thread");
    }
  }

  async function createOrSelectPrMrThreadAndSendMessage(content: string, mode: ChatMode = "default") {
    if (!selectedWorktreeId) {
      onError("Worktree is not selected");
      return null;
    }

    onError(null);
    setSendingMessage(true);
    try {
      const created = await api.getOrCreatePrMrThread(selectedWorktreeId);
      optimisticCreatedThreadIdsRef.current.add(created.id);
      setThreads((current) => {
        const existingIndex = current.findIndex((thread) => thread.id === created.id);
        if (existingIndex === -1) {
          return [...current, created];
        }
        const updated = [...current];
        updated[existingIndex] = created;
        return updated;
      });
      setSelectedThreadId(created.id);
      queryClient.setQueryData<ChatThread[] | undefined>(queryKeys.threads.list(selectedWorktreeId), (current) => {
        if (!current) {
          return current;
        }
        const existingIndex = current.findIndex((thread) => thread.id === created.id);
        if (existingIndex === -1) {
          return [...current, created];
        }
        const updated = [...current];
        updated[existingIndex] = created;
        return updated;
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(selectedWorktreeId) });
      invalidateRepositoryReviews();
      startWaitingAssistant(created.id);
      setThreads((current) => applyThreadModeUpdate(current, created.id, mode));
      queryClient.setQueryData<ChatThread[] | undefined>(
        queryKeys.threads.list(selectedWorktreeId),
        (current) => current ? applyThreadModeUpdate(current, created.id, mode) : current,
      );
      await api.sendMessage(created.id, {
        content,
        mode,
        attachments: [],
        expectedWorktreeId: created.worktreeId,
      });
      invalidateRepositoryReviews();
      return created;
    } catch (e) {
      setWaitingAssistant(null);
      onError(e instanceof Error ? e.message : "Failed to create PR/MR thread");
      return null;
    } finally {
      setSendingMessage(false);
    }
  }

  async function closeThread(threadId: string) {
    onError(null);
    setClosingThreadId(threadId);
    try {
      const closedThreadWasPrMr = threads.some((thread) => thread.id === threadId && thread.kind === "review");
      await api.deleteThread(threadId);
      setThreads((current) => {
        const updated = current.filter((t) => t.id !== threadId);
        if (selectedThreadId === threadId) {
          const nextThreadId = resolvePreferredThreadId(updated);
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
      if (closedThreadWasPrMr) {
        invalidateRepositoryReviews();
      }
      clearThreadTrackingState(threadId);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to close session");
    } finally {
      setClosingThreadId(null);
    }
  }

  async function renameThreadTitle(threadId: string, title: string) {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;
    onError(null);
    try {
      const updated = await api.renameThreadTitle(threadId, { title: normalizedTitle });
      setThreads((current) => applyThreadTitleUpdate(current, updated.id, updated.title));
      const cacheWorktreeId = selectedWorktreeId ?? updated.worktreeId;
      if (cacheWorktreeId) {
        queryClient.setQueryData<ChatThread[] | undefined>(
          queryKeys.threads.list(cacheWorktreeId),
          (current) => {
            if (!current) return current;
            return applyThreadTitleUpdate(current, updated.id, updated.title);
          },
        );
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to rename thread title");
    }
  }

  async function setThreadMode(threadId: string, mode: ChatMode) {
    const currentThread = threads.find((thread) => thread.id === threadId) ?? null;
    if (currentThread?.mode === mode) {
      return;
    }

    onError(null);
    const previousThreads = threads;
    const cacheWorktreeId = selectedWorktreeId ?? previousThreads.find((thread) => thread.id === threadId)?.worktreeId ?? null;

    setThreads((current) => applyThreadModeUpdate(current, threadId, mode));
    if (cacheWorktreeId) {
      queryClient.setQueryData<ChatThread[] | undefined>(
        queryKeys.threads.list(cacheWorktreeId),
        (current) => current ? applyThreadModeUpdate(current, threadId, mode) : current,
      );
    }

    try {
      const updated = await api.updateThreadMode(threadId, { mode });
      setThreads((current) => applyThreadModeUpdate(current, updated.id, updated.mode));
      const updatedCacheWorktreeId = selectedWorktreeId ?? updated.worktreeId;
      if (updatedCacheWorktreeId) {
        queryClient.setQueryData<ChatThread[] | undefined>(
          queryKeys.threads.list(updatedCacheWorktreeId),
          (current) => current ? applyThreadModeUpdate(current, updated.id, updated.mode) : current,
        );
      }
    } catch (e) {
      setThreads(previousThreads);
      if (cacheWorktreeId) {
        queryClient.setQueryData<ChatThread[] | undefined>(queryKeys.threads.list(cacheWorktreeId), previousThreads);
      }
      onError(e instanceof Error ? e.message : "Failed to update thread mode");
    }
  }

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

    const activeThread = findThreadForWorktree(threads, selectedThreadId, selectedWorktreeId);
    if (!activeThread) {
      onError("Selected thread is stale for the active worktree. Please retry.");
      return false;
    }

    startWaitingAssistant(activeThread.id);
    if (selectedWorktreeId) {
      queryClient.setQueryData<ChatThread[] | undefined>(queryKeys.threads.list(selectedWorktreeId), (current) => {
        if (!current) return current;
        const index = current.findIndex((thread) => thread.id === activeThread.id);
        if (index === -1 || current[index]?.active) return current;
        const updated = [...current];
        updated[index] = { ...updated[index]!, active: true };
        return updated;
      });
    }
    setSendingMessage(true);
    onError(null);

    try {
      setThreads((current) => applyThreadModeUpdate(current, activeThread.id, mode));
      if (selectedWorktreeId) {
        queryClient.setQueryData<ChatThread[] | undefined>(
          queryKeys.threads.list(selectedWorktreeId),
          (current) => current ? applyThreadModeUpdate(current, activeThread.id, mode) : current,
        );
      }
      await api.sendMessage(activeThread.id, {
        content,
        mode,
        attachments: attachmentsToSend,
        expectedWorktreeId: activeThread.worktreeId,
      });
      if (shouldInvalidateSnapshot) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.threads.timelineSnapshot(activeThread.id) });
      }
      return true;
    } catch (e) {
      setWaitingAssistant(null);
      onError(e instanceof Error ? e.message : "Failed to send message");
      return false;
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

  const hasStreamingAssistantMessage =
    selectedThreadId != null &&
    messages.some(
      (m) =>
        m.threadId === selectedThreadId &&
        m.role === "assistant" &&
        streamingMessageIdsRef.current.has(m.id),
    );

  const showStopAction = selectedThreadId != null && (selectedThreadIsRunning || hasStreamingAssistantMessage);

  const stopRequestedForActiveThread = selectedThreadId != null && stopRequestedThreadId === selectedThreadId;
  const stoppingRun =
    selectedThreadId != null && (stoppingThreadId === selectedThreadId || stopRequestedForActiveThread);

  useEffect(() => {
    if (!showStopAction) setStopRequestedThreadId(null);
  }, [showStopAction]);

  const serverTimelineItems = (queriedThreadSnapshot?.timelineItems ?? []) as unknown as ChatTimelineItem[];
  const serverTimelineSummary = queriedThreadSnapshot?.summary as ChatTimelineSummary | undefined;
  const timelineSeedMatchesLiveState =
    selectedThreadId != null
    && queriedThreadSnapshot != null
    && queriedThreadSnapshot.messages.length === messages.length
    && queriedThreadSnapshot.events.length === events.length
    && queriedThreadSnapshot.newestIdx === (events[events.length - 1]?.idx ?? null)
    && queriedThreadSnapshot.newestSeq === (messages[messages.length - 1]?.seq ?? null);

  const derivedTimeline = useWorkspaceTimeline(messages, events, selectedThreadId, {
    streamingMessageIds: streamingMessageIdsRef.current,
    stickyRawFallbackMessageIds: stickyRawFallbackMessageIdsRef.current,
    renderDecisionByMessageId: renderDecisionByMessageIdRef.current,
    loggedOrphanEventIdsByThread: loggedOrphanEventIdsByThreadRef.current,
    claimedContextEventIdsByThreadMessage: claimedContextEventIdsByThreadMessageRef.current,
  }, {
    semanticHydrationInProgress: false,
    disabled: !timelineEnabled,
  });

  const useServerTimeline = timelineEnabled && timelineSeedMatchesLiveState && serverTimelineSummary != null;

  const timelineData: {
    items: ChatTimelineItem[];
    summary: ChatTimelineSummary;
  } = useServerTimeline
    ? {
        items: serverTimelineItems,
        summary: serverTimelineSummary,
      }
    : {
        items: derivedTimeline.items,
        summary: derivedTimeline.summary,
      };

  const timelineComparison = useMemo(() => {
    const server = summarizeTimelineItems(serverTimelineItems);
    const derived = summarizeTimelineItems(derivedTimeline.items);
    const hasSuspiciousSubagentOrExploreState =
      server.exploreCards > 0
      || derived.exploreCards > 0
      || server.subagentCards > 0
      || derived.subagentCards > 0;
    const signaturesMatch = JSON.stringify(server.signatures) === JSON.stringify(derived.signatures);

    return {
      server,
      derived,
      hasSuspiciousSubagentOrExploreState,
      signaturesMatch,
    };
  }, [derivedTimeline.items, serverTimelineItems]);

  useEffect(() => {
    if (!timelineComparison.hasSuspiciousSubagentOrExploreState) {
      return;
    }

    pushRenderDebug({
      source: "useChatSession",
      event: "timelineSourceDecision",
      messageId: selectedThreadId ?? undefined,
      details: {
        selectedThreadId,
        timelineEnabled,
        timelineSeedMatchesLiveState,
        useServerTimeline,
        signaturesMatch: timelineComparison.signaturesMatch,
        server: timelineComparison.server,
        derived: timelineComparison.derived,
      },
    });
  }, [
    selectedThreadId,
    timelineComparison,
    timelineEnabled,
    timelineSeedMatchesLiveState,
    useServerTimeline,
  ]);

  const timelineItems = timelineData.items;
  const timelineSummary = timelineData.summary;

  return {
    threads,
    selectedThreadId,
    setSelectedThreadId,
    messages,
    events,
    closingThreadId,

    sendingMessage,
    waitingAssistant,
    selectedThreadUiStatus,
    composerMode,
    composerModeLocked,
    composerDisabled,
    showStopAction,
    stoppingRun,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    semanticHydrationInProgress: false,

    timelineItems,
    timelineSummary,

    createAdditionalThread,
    createThreadAndSendMessage,
    createOrSelectPrMrThreadAndSendMessage,
    closeThread,
    renameThreadTitle,
    setThreadMode,
    submitMessage,
    loadOlderHistory: async () => {},
    stopAssistantRun,

    startWaitingAssistant,
    clearWaitingAssistantForThread,
  };
}
