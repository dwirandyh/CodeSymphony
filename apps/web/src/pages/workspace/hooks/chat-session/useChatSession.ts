import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { DEFAULT_CHAT_MODEL_BY_AGENT } from "@codesymphony/shared-types";
import type {
  AttachmentInput,
  ChatAttachment,
  ChatEvent,
  ChatMessage,
  ChatMode,
  ChatQueuedMessage,
  ChatThread,
  ChatThreadPermissionMode,
  ChatTimelineItem,
  ChatTimelineSnapshot,
  ChatTimelineSummary,
  CliAgent,
  CreateChatThreadInput,
  UpdateChatThreadAgentSelectionInput,
} from "@codesymphony/shared-types";
import { api } from "../../../../lib/api";
import { debugLog } from "../../../../lib/debugLog";
import {
  disposeAllThreadCollections,
  disposeThreadCollections,
  getThreadCollectionCounts,
  getThreadCollections,
  getThreadMessagesCollection,
  pruneThreadCollections,
} from "../../../../collections/threadCollections";
import { getThreadsCollection, toPlainChatThread } from "../../../../collections/threads";
import { hydrateThreadFromSnapshot } from "../../../../collections/threadHydrator";
import {
  allocateNextThreadMessageSeq,
  clearAllThreadStreamState,
  clearThreadStreamState,
  getThreadLastAppliedSnapshotKey,
  getThreadLastEventIdx,
  getThreadLastMessageSeq,
  setThreadLastAppliedSnapshotKey,
  setThreadLastMessageSeq,
} from "../../../../collections/threadStreamState";
import { pushRenderDebug } from "../../../../lib/renderDebug";
import { isThreadNavigationPerfEnabled, pushThreadNavigationPerf } from "../../../../lib/threadNavigationPerf";
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
  hasRunningAssistantActivity,
  isPlanReviewReady,
  type WorktreeThreadUiStatus,
} from "../worktreeThreadStatus";
import type {
  UseChatSessionOptions,
} from "./useChatSession.types";
import {
  resolveSnapshotSeedDecision,
  buildSnapshotKey,
  shouldInvalidateSnapshotImmediatelyAfterSubmit,
} from "./hydrationUtils";
import { areMessagesEqual } from "../messageMerge";
import {
  applyThreadModeUpdate,
  applyThreadPermissionModeUpdate,
  applyThreadTitleUpdate,
  extractLatestThreadMetadata,
} from "./snapshotSeed";
import { useThreadEventStream } from "./useThreadEventStream";

const DEFAULT_THREAD_TITLE = "New Thread";
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_EVENTS: ChatEvent[] = [];
const pendingAutoCreateWorktreeIds = new Set<string>();

type ThreadNavigationPerfSession = {
  navId: string;
  threadId: string;
  worktreeId: string | null;
  startedAtMs: number;
  fromThreadId: string | null;
  requestedThreadId: string | null;
  snapshotStatusSignature: string | null;
  renderSignature: string | null;
  localStateLogged: boolean;
  readyLogged: boolean;
};

function summarizeThreadCollectionState(params: {
  threadId: string | null;
  messages: ChatMessage[];
  events: ChatEvent[];
}) {
  const firstMessage = params.messages[0] ?? null;
  const lastMessage = params.messages[params.messages.length - 1] ?? null;
  const firstEvent = params.events[0] ?? null;
  const lastEvent = params.events[params.events.length - 1] ?? null;

  return {
    threadId: params.threadId,
    messagesCount: params.messages.length,
    eventsCount: params.events.length,
    firstMessageId: firstMessage?.id ?? null,
    firstMessageSeq: firstMessage?.seq ?? null,
    lastMessageId: lastMessage?.id ?? null,
    lastMessageSeq: lastMessage?.seq ?? null,
    firstEventIdx: firstEvent?.idx ?? null,
    lastEventIdx: lastEvent?.idx ?? null,
  };
}

function getPerfNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
}

function roundPerfMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function buildThreadNavigationPerfNavId(threadId: string): string {
  return `thread-nav:${threadId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function getThreadNavigationPerfElapsedMs(session: ThreadNavigationPerfSession): number {
  return roundPerfMs(getPerfNow() - session.startedAtMs);
}

export function resetPendingAutoCreateWorktreesForTest() {
  pendingAutoCreateWorktreeIds.clear();
}

function mergeTrackedThreads(params: {
  queriedThreads: ChatThread[];
  currentThreads: ChatThread[];
  optimisticCreatedThreadIds: Set<string>;
  locallyDeletedThreadIds: Set<string>;
}): ChatThread[] {
  const {
    queriedThreads,
    currentThreads,
    optimisticCreatedThreadIds,
    locallyDeletedThreadIds,
  } = params;
  const optimisticThreads = currentThreads.filter((thread) =>
    optimisticCreatedThreadIds.has(thread.id) && !locallyDeletedThreadIds.has(thread.id),
  );
  const mergedThreads = queriedThreads.filter((thread) => !locallyDeletedThreadIds.has(thread.id));

  for (const optimisticThread of optimisticThreads) {
    if (!mergedThreads.some((thread) => thread.id === optimisticThread.id)) {
      mergedThreads.push(optimisticThread);
    }
  }

  return mergedThreads;
}

export function resolveWorktreeSwitchSeed(params: {
  cachedThreads: ChatThread[];
  requestedThreadId: string | null;
  optimisticCreatedThreadIds: Set<string>;
  locallyDeletedThreadIds: Set<string>;
}): { threads: ChatThread[]; selectedThreadId: string | null } {
  const threads = mergeTrackedThreads({
    queriedThreads: params.cachedThreads,
    currentThreads: [],
    optimisticCreatedThreadIds: params.optimisticCreatedThreadIds,
    locallyDeletedThreadIds: params.locallyDeletedThreadIds,
  });

  return {
    threads,
    selectedThreadId: params.requestedThreadId ?? resolvePreferredThreadId(threads),
  };
}

function applyThreadActiveUpdate(
  threads: ChatThread[],
  threadId: string,
  active: boolean,
): ChatThread[] {
  const index = threads.findIndex((thread) => thread.id === threadId);
  if (index === -1 || threads[index]?.active === active) {
    return threads;
  }

  const updated = [...threads];
  updated[index] = { ...updated[index]!, active };
  return updated;
}

function applyThreadAgentSelectionUpdate(
  threads: ChatThread[],
  threadId: string,
  selection: UpdateChatThreadAgentSelectionInput,
): ChatThread[] {
  const index = threads.findIndex((thread) => thread.id === threadId);
  if (index === -1) {
    return threads;
  }

  const current = threads[index];
  if (
    current?.agent === selection.agent
    && current.model === selection.model
    && current.modelProviderId === (selection.modelProviderId ?? null)
    && current.claudeSessionId === null
    && current.codexSessionId === null
    && current.cursorSessionId === null
    && current.opencodeSessionId === null
  ) {
    return threads;
  }

  const updated = [...threads];
  updated[index] = {
    ...current!,
    agent: selection.agent,
    model: selection.model,
    modelProviderId: selection.modelProviderId ?? null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    opencodeSessionId: null,
  };
  return updated;
}

function replaceThread(threads: ChatThread[], nextThread: ChatThread): ChatThread[] {
  const index = threads.findIndex((thread) => thread.id === nextThread.id);
  if (index === -1) {
    return [...threads, nextThread];
  }

  const updated = [...threads];
  updated[index] = nextThread;
  return updated;
}

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

function buildThreadSelectionInput(thread: ChatThread | null): Pick<CreateChatThreadInput, "agent" | "model" | "modelProviderId"> {
  if (!thread) {
    return {};
  }

  return {
    agent: thread.agent,
    model: thread.model,
    modelProviderId: thread.modelProviderId,
  };
}

function getCachedThreadsForWorktree(
  queryClient: ReturnType<typeof useQueryClient>,
  worktreeId: string,
): ChatThread[] {
  return (getThreadsCollection(queryClient, worktreeId).toArray as ChatThread[]).map((thread) => toPlainChatThread(thread));
}

function shouldDelayRemoteBootstrapForLocalThread(params: {
  selectedThreadId: string | null;
  optimisticCreatedThreadIds: Set<string>;
  waitingAssistant: { threadId: string; afterIdx: number } | null;
}): boolean {
  const { selectedThreadId, optimisticCreatedThreadIds, waitingAssistant } = params;
  if (!selectedThreadId || !optimisticCreatedThreadIds.has(selectedThreadId)) {
    return false;
  }

  return (
    getThreadLastEventIdx(selectedThreadId) == null
    && getThreadLastMessageSeq(selectedThreadId) == null
    && waitingAssistant?.threadId !== selectedThreadId
  );
}

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

function hasCanonicalThreadSnapshot(snapshot: ChatTimelineSnapshot | null | undefined): boolean {
  return snapshot != null && snapshot.collectionsIncluded !== false;
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

function toPlainChatMessage(message: ChatMessage): ChatMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    seq: message.seq,
    role: message.role,
    content: message.content,
    attachments: message.attachments,
    createdAt: message.createdAt,
  };
}

function toPlainChatEvent(event: ChatEvent): ChatEvent {
  return {
    id: event.id,
    threadId: event.threadId,
    idx: event.idx,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

function cloneSortedIfNeeded<T>(rows: T[], compare: (left: T, right: T) => number): T[] {
  for (let index = 1; index < rows.length; index += 1) {
    if (compare(rows[index - 1], rows[index]) > 0) {
      return [...rows].sort(compare);
    }
  }

  return rows;
}

function isSnapshotFreshEnoughForAuthoritativeTimeline(params: {
  snapshot: ChatTimelineSnapshot | null | undefined;
  messages: ChatMessage[];
  events: ChatEvent[];
}): boolean {
  const { snapshot, messages, events } = params;
  if (!snapshot) {
    return false;
  }

  const snapshotNewestIdx = snapshot.newestIdx ?? snapshot.events[snapshot.events.length - 1]?.idx ?? null;
  const snapshotNewestSeq = snapshot.newestSeq ?? snapshot.messages[snapshot.messages.length - 1]?.seq ?? null;
  const localNewestIdx = events[events.length - 1]?.idx ?? null;
  const localNewestSeq = messages[messages.length - 1]?.seq ?? null;

  const eventCoverage = localNewestIdx == null || (snapshotNewestIdx != null && snapshotNewestIdx >= localNewestIdx);
  const messageCoverage = localNewestSeq == null || (snapshotNewestSeq != null && snapshotNewestSeq >= localNewestSeq);

  return eventCoverage && messageCoverage;
}

function doesSnapshotMatchLocalLiveState(params: {
  snapshot: ChatTimelineSnapshot | null | undefined;
  messages: ChatMessage[];
  events: ChatEvent[];
}): boolean {
  const { snapshot, messages, events } = params;
  if (!snapshot || snapshot.collectionsIncluded === false) {
    return false;
  }

  if (snapshot.messages.length !== messages.length || snapshot.events.length !== events.length) {
    return false;
  }

  const snapshotFirstMessage = snapshot.messages[0] ?? null;
  const snapshotLastMessage = snapshot.messages[snapshot.messages.length - 1] ?? null;
  const localFirstMessage = messages[0] ?? null;
  const localLastMessage = messages[messages.length - 1] ?? null;
  if (
    (snapshotFirstMessage?.id ?? null) !== (localFirstMessage?.id ?? null)
    || (snapshotFirstMessage?.seq ?? null) !== (localFirstMessage?.seq ?? null)
    || (snapshotLastMessage?.id ?? null) !== (localLastMessage?.id ?? null)
    || (snapshotLastMessage?.seq ?? null) !== (localLastMessage?.seq ?? null)
  ) {
    return false;
  }

  const snapshotFirstEvent = snapshot.events[0] ?? null;
  const snapshotLastEvent = snapshot.events[snapshot.events.length - 1] ?? null;
  const localFirstEvent = events[0] ?? null;
  const localLastEvent = events[events.length - 1] ?? null;
  if (
    (snapshotFirstEvent?.id ?? null) !== (localFirstEvent?.id ?? null)
    || (snapshotFirstEvent?.idx ?? null) !== (localFirstEvent?.idx ?? null)
    || (snapshotLastEvent?.id ?? null) !== (localLastEvent?.id ?? null)
    || (snapshotLastEvent?.idx ?? null) !== (localLastEvent?.idx ?? null)
  ) {
    return false;
  }

  return true;
}

function doesSnapshotCoverLocalHead(params: {
  snapshot: ChatTimelineSnapshot | null | undefined;
  messages: ChatMessage[];
  events: ChatEvent[];
}): boolean {
  const { snapshot, messages, events } = params;
  if (!snapshot || snapshot.collectionsIncluded === false) {
    return true;
  }

  const snapshotOldestMessageSeq = snapshot.messages[0]?.seq ?? null;
  const snapshotOldestEventIdx = snapshot.events[0]?.idx ?? null;
  const localOldestMessageSeq = messages[0]?.seq ?? null;
  const localOldestEventIdx = events[0]?.idx ?? null;

  const messageHeadCovered =
    localOldestMessageSeq == null
    || snapshotOldestMessageSeq == null
    || snapshotOldestMessageSeq <= localOldestMessageSeq;
  const eventHeadCovered =
    localOldestEventIdx == null
    || snapshotOldestEventIdx == null
    || snapshotOldestEventIdx <= localOldestEventIdx;

  return messageHeadCovered && eventHeadCovered;
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
  const eventDerivedThreadRunning = hasRunningAssistantActivity(events);
  const selectedThreadUiStatus = deriveThreadUiStatusFromEvents(
    events,
    Boolean(selectedThread?.active) || optimisticThreadRunning || eventDerivedThreadRunning,
  );

  return {
    selectedThreadUiStatus,
    composerDisabled: !selectedThreadId || sendingMessage || selectedThreadUiStatus !== "idle",
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
  const requestedThreadSelectionDeferred =
    options?.desiredWorktreeId != null
    && options.desiredWorktreeId !== selectedWorktreeId;
  const requestedThreadId = requestedThreadSelectionDeferred
    ? null
    : options?.desiredThreadId ?? null;

  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [selectedThreadIdState, setSelectedThreadIdState] = useState<string | null>(() => requestedThreadId);

  const [sendingMessage, setSendingMessage] = useState(false);
  const [stoppingThreadId, setStoppingThreadId] = useState<string | null>(null);
  const [stopRequestedThreadId, setStopRequestedThreadId] = useState<string | null>(null);
  const [closingThreadId, setClosingThreadId] = useState<string | null>(null);
  const [waitingAssistant, setWaitingAssistant] = useState<{ threadId: string; afterIdx: number } | null>(null);
  const [pendingComposerPermissionMode, setPendingComposerPermissionMode] = useState<ChatThreadPermissionMode>("default");

  const streamingMessageIdsRef = useRef<Set<string>>(new Set());
  const stickyRawFallbackMessageIdsRef = useRef<Set<string>>(new Set());
  const renderDecisionByMessageIdRef = useRef<Map<string, string>>(new Map());
  const loggedOrphanEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const claimedContextEventIdsByThreadMessageRef = useRef<Map<string, Set<string>>>(new Map());
  const activeThreadIdRef = useRef<string | null>(null);
  const selectedThreadIdOverrideRef = useRef<string | null>(null);
  const threadsRef = useRef<ChatThread[]>([]);
  const threadByIdRef = useRef<Map<string, ChatThread>>(new Map());
  const creatingThreadRef = useRef(false);
  const optimisticCreatedThreadIdsRef = useRef<Set<string>>(new Set());
  const locallyDeletedThreadIdsRef = useRef<Set<string>>(new Set());
  const prevThreadIdRef = useRef<string | null>(null);
  const prevSeedThreadRef = useRef<string | null>(null);
  const prevRequestedThreadIdRef = useRef<string | null>(null);
  const prevRequestedThreadExistsRef = useRef(false);
  const restoredActiveThreadIdsRef = useRef<Set<string>>(new Set());
  const restoredWaitingThreadIdsRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const pendingAgentSelectionUpdatesRef = useRef<Map<string, Promise<void>>>(new Map());
  const activeThreadNavigationPerfRef = useRef<ThreadNavigationPerfSession | null>(null);
  const previousThreadNavigationPerfThreadIdRef = useRef<string | null>(null);
  const lastThreadSelectionRef = useRef<{
    worktreeId: string;
    agent: CliAgent;
    model: string;
    modelProviderId: string | null;
  } | null>(null);

  const selectedThreadId = selectedThreadIdOverrideRef.current ?? selectedThreadIdState;
  activeThreadIdRef.current = selectedThreadId;
  threadsRef.current = threads;

  const threadByIdMap = threadByIdRef.current;
  if (threadByIdMap.size !== threads.length || threads.some((t) => threadByIdMap.get(t.id) !== t)) {
    threadByIdMap.clear();
    for (const thread of threads) {
      threadByIdMap.set(thread.id, thread);
    }
  }

  const { data: queriedThreads, isLoading: queriedThreadsLoading } = useThreads(selectedWorktreeId);

  const prevWorktreeIdRef2 = useRef<string | null>(selectedWorktreeId);

  const setSelectedThreadId = useCallback((threadId: string | null) => {
    selectedThreadIdOverrideRef.current = threadId;
    setSelectedThreadIdState(threadId);
  }, []);

  useEffect(() => {
    if (selectedThreadIdOverrideRef.current === selectedThreadIdState) {
      selectedThreadIdOverrideRef.current = null;
    }
  }, [selectedThreadIdState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      disposeAllThreadCollections();
      clearAllThreadStreamState();
    };
  }, []);

  useEffect(() => {
    const worktreeChanged = selectedWorktreeId !== prevWorktreeIdRef2.current;

    if (!selectedWorktreeId) {
      prevWorktreeIdRef2.current = selectedWorktreeId;
      setWaitingAssistant(null);
      setThreads([]);
      setSelectedThreadId(null);
      pendingAgentSelectionUpdatesRef.current.clear();
      disposeAllThreadCollections();
      clearAllThreadStreamState();
      setPendingComposerPermissionMode("default");
      return;
    }

    if (worktreeChanged) {
      const worktreeSwitchSeed = resolveWorktreeSwitchSeed({
        cachedThreads: getCachedThreadsForWorktree(queryClient, selectedWorktreeId),
        requestedThreadId,
        optimisticCreatedThreadIds: optimisticCreatedThreadIdsRef.current,
        locallyDeletedThreadIds: locallyDeletedThreadIdsRef.current,
      });

      setWaitingAssistant(null);
      setThreads(worktreeSwitchSeed.threads);
      setSelectedThreadId(worktreeSwitchSeed.selectedThreadId);
      pendingAgentSelectionUpdatesRef.current.clear();
      setPendingComposerPermissionMode("default");
    }

    if (!queriedThreads) return;

    prevWorktreeIdRef2.current = selectedWorktreeId;

    setThreads((current) => {
      const mergedThreads = mergeTrackedThreads({
        queriedThreads,
        currentThreads: current,
        optimisticCreatedThreadIds: optimisticCreatedThreadIdsRef.current,
        locallyDeletedThreadIds: locallyDeletedThreadIdsRef.current,
      });

      if (current.length === mergedThreads.length && current.every((t, i) => (
        t.id === mergedThreads[i].id
        && t.title === mergedThreads[i].title
        && t.mode === mergedThreads[i].mode
        && t.permissionMode === mergedThreads[i].permissionMode
        && t.agent === mergedThreads[i].agent
        && t.model === mergedThreads[i].model
        && t.modelProviderId === mergedThreads[i].modelProviderId
        && t.claudeSessionId === mergedThreads[i].claudeSessionId
        && t.codexSessionId === mergedThreads[i].codexSessionId
        && t.cursorSessionId === mergedThreads[i].cursorSessionId
        && t.opencodeSessionId === mergedThreads[i].opencodeSessionId
        && t.active === mergedThreads[i].active
        && t.updatedAt === mergedThreads[i].updatedAt
      ))) {
        return current;
      }
      return mergedThreads;
    });

    const trackedThreads = mergeTrackedThreads({
      queriedThreads,
      currentThreads: threadsRef.current,
      optimisticCreatedThreadIds: optimisticCreatedThreadIdsRef.current,
      locallyDeletedThreadIds: locallyDeletedThreadIdsRef.current,
    });

    if (requestedThreadSelectionDeferred) {
      return;
    }

    if (queriedThreads.length > 0 || trackedThreads.length > 0) {
      pendingAutoCreateWorktreeIds.delete(selectedWorktreeId);
    }

    const requestedThreadIdChanged = prevRequestedThreadIdRef.current !== requestedThreadId;

    if (requestedThreadIdChanged) {
      prevRequestedThreadIdRef.current = requestedThreadId;
    }

    const waitingForInitialThreads =
      queriedThreadsLoading
      && queriedThreads.length === 0
      && trackedThreads.length === 0;

    if (waitingForInitialThreads) {
      return;
    }

    const shouldAutoCreateInitialThread =
      !queriedThreadsLoading
      && queriedThreads != null
      && queriedThreads.length === 0
      && trackedThreads.length === 0
      && closingThreadId == null
      && !pendingAutoCreateWorktreeIds.has(selectedWorktreeId);

    if (shouldAutoCreateInitialThread) {
      if (creatingThreadRef.current) return;
      const creationWorktreeId = selectedWorktreeId;
      const creationPermissionMode = pendingComposerPermissionMode;
      const creationSelection = lastThreadSelectionRef.current?.worktreeId === creationWorktreeId
        ? lastThreadSelectionRef.current
        : null;
      pendingAutoCreateWorktreeIds.add(creationWorktreeId);
      creatingThreadRef.current = true;
      void (async () => {
        try {
          const created = await api.createThread(creationWorktreeId, {
            permissionMode: creationPermissionMode,
            ...(creationSelection ? {
              agent: creationSelection.agent,
              model: creationSelection.model,
              modelProviderId: creationSelection.modelProviderId,
            } : {}),
          });
          if (!mountedRef.current || prevWorktreeIdRef2.current !== creationWorktreeId) {
            if (prevWorktreeIdRef2.current !== creationWorktreeId) {
              pendingAutoCreateWorktreeIds.delete(creationWorktreeId);
            }
            return;
          }
          optimisticCreatedThreadIdsRef.current.add(created.id);
          locallyDeletedThreadIdsRef.current.delete(created.id);
          setThreads((current) => (
            current.some((thread) => thread.id === created.id) ? current : [...current, created]
          ));
          if (activeThreadIdRef.current == null && threadsRef.current.length === 0) {
            setSelectedThreadId(created.id);
          }
          syncThreadIntoCache(creationWorktreeId, created);
          void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(creationWorktreeId) });
        } catch (e) {
          pendingAutoCreateWorktreeIds.delete(creationWorktreeId);
          if (mountedRef.current && prevWorktreeIdRef2.current === creationWorktreeId) {
            onError(e instanceof Error ? e.message : "Failed to load threads");
          }
        } finally {
          creatingThreadRef.current = false;
        }
      })();
      return;
    }

    const requestedThreadExists =
      requestedThreadId != null && trackedThreads.some((thread) => thread.id === requestedThreadId);
    const selectedThreadStillExists =
      selectedThreadId != null && trackedThreads.some((thread) => thread.id === selectedThreadId);
    const requestedThreadReappeared =
      requestedThreadId != null && requestedThreadExists && !prevRequestedThreadExistsRef.current;

    prevRequestedThreadExistsRef.current = requestedThreadExists;

    if (requestedThreadIdChanged || requestedThreadReappeared) {
      const nextThreadId = requestedThreadExists
        ? requestedThreadId
        : resolvePreferredThreadId(trackedThreads);
      if (selectedThreadId !== nextThreadId) {
        setSelectedThreadId(nextThreadId);
      }
      return;
    }

    if (selectedThreadStillExists) {
      return;
    }

    if (requestedThreadExists) {
      setSelectedThreadId(requestedThreadId);
      return;
    }

    const nextThreadId = resolvePreferredThreadId(trackedThreads);
    if (selectedThreadId !== nextThreadId) {
      setSelectedThreadId(nextThreadId);
    }
  }, [
    closingThreadId,
    pendingComposerPermissionMode,
    queriedThreads,
    requestedThreadId,
    requestedThreadSelectionDeferred,
    selectedThreadId,
    selectedWorktreeId,
  ]);

  useEffect(() => {
    if (!selectedThreadId) return;
    if (restoredActiveThreadIdsRef.current.has(selectedThreadId)) return;

    const thread = threadByIdRef.current.get(selectedThreadId);
    if (thread?.active) {
      restoredActiveThreadIdsRef.current.add(selectedThreadId);
      startWaitingAssistant(selectedThreadId, { restored: true });
    }
  }, [selectedThreadId, threads]);

  const selectedThreadIdForData =
    selectedThreadId != null && !locallyDeletedThreadIdsRef.current.has(selectedThreadId)
      ? selectedThreadId
      : null;
  const { data: liveMessages } = useLiveQuery(
    () => selectedThreadIdForData ? getThreadCollections(selectedThreadIdForData).messagesCollection : undefined,
    [selectedThreadIdForData],
  );
  const { data: liveEvents } = useLiveQuery(
    () => selectedThreadIdForData ? getThreadCollections(selectedThreadIdForData).eventsCollection : undefined,
    [selectedThreadIdForData],
  );
  const messages = useMemo(
    () => {
      if (!liveMessages) {
        return EMPTY_MESSAGES;
      }

      const plainMessages = liveMessages.map((message) => toPlainChatMessage(message as ChatMessage));
      return cloneSortedIfNeeded(plainMessages, (left, right) => left.seq - right.seq);
    },
    [liveMessages],
  );
  const events = useMemo(
    () => {
      if (!liveEvents) {
        return EMPTY_EVENTS;
      }

      const plainEvents = liveEvents.map((event) => toPlainChatEvent(event as ChatEvent));
      return cloneSortedIfNeeded(plainEvents, (left, right) => left.idx - right.idx);
    },
    [liveEvents],
  );
  useEffect(() => {
    if (!selectedThreadId) {
      return;
    }

    debugLog("thread.timeline.state", "selectedThread.collections.changed", summarizeThreadCollectionState({
      threadId: selectedThreadId,
      messages,
      events,
    }));
  }, [
    events,
    messages,
    selectedThreadId,
  ]);
  const selectedThread = selectedThreadId
    ? threadByIdRef.current.get(selectedThreadId) ?? null
    : null;
  const pendingPermissionRequests = useMemo(
    () => derivePendingPermissionRequests(events),
    [events],
  );
  const pendingQuestionRequests = useMemo(
    () => derivePendingQuestionRequests(events),
    [events],
  );
  const pendingPlan = useMemo(
    () => derivePendingPlan(events),
    [events],
  );
  const eventDerivedThreadRunning = useMemo(
    () => hasRunningAssistantActivity(events),
    [events],
  );
  const hasPendingPermissionRequests = pendingPermissionRequests.length > 0;
  const hasPendingQuestionRequests = pendingQuestionRequests.length > 0;
  const hasPendingPlan = pendingPlan?.status === "pending" && isPlanReviewReady(events, pendingPlan);
  const hasPendingUserGate = hasPendingPermissionRequests || hasPendingQuestionRequests || hasPendingPlan;
  const selectedThreadUiStatus = useMemo<WorktreeThreadUiStatus>(() => {
    const optimisticThreadRunning =
      selectedThreadId != null
      && (sendingMessage || waitingAssistant?.threadId === selectedThreadId);

    if (hasPendingPermissionRequests || hasPendingQuestionRequests) {
      return "waiting_approval";
    }

    if (pendingPlan?.status === "pending" && isPlanReviewReady(events, pendingPlan)) {
      return "review_plan";
    }

    if (Boolean(selectedThread?.active) || optimisticThreadRunning || eventDerivedThreadRunning) {
      return "running";
    }

    return "idle";
  }, [
    eventDerivedThreadRunning,
    events,
    hasPendingPermissionRequests,
    hasPendingQuestionRequests,
    pendingPlan,
    selectedThread?.active,
    selectedThreadId,
    sendingMessage,
    waitingAssistant,
  ]);
  const composerDisabled =
    !selectedThreadId
    || sendingMessage
    || (selectedThreadUiStatus !== "idle" && selectedThreadUiStatus !== "running");
  const selectedThreadIsRunning = selectedThreadUiStatus === "running";
  const selectedThreadCreatedLocally =
    selectedThreadId != null && optimisticCreatedThreadIdsRef.current.has(selectedThreadId);
  const shouldDelaySelectedThreadRemoteBootstrap = shouldDelayRemoteBootstrapForLocalThread({
    selectedThreadId,
    optimisticCreatedThreadIds: optimisticCreatedThreadIdsRef.current,
    waitingAssistant,
  });
  const selectedThreadHasLocalState =
    selectedThreadId != null && (messages.length > 0 || events.length > 0);
  const selectedThreadHasAppliedSnapshot =
    selectedThreadId != null && getThreadLastAppliedSnapshotKey(selectedThreadId) != null;
  const selectedThreadHasCompleteLocalHistory =
    selectedThreadHasLocalState || selectedThreadHasAppliedSnapshot;
  const shouldUseLocalCompleteThreadCache =
    selectedThreadHasCompleteLocalHistory
    && selectedThread?.active !== true
    && waitingAssistant?.threadId !== selectedThreadId;
  const snapshotBootstrapThreadId =
    shouldDelaySelectedThreadRemoteBootstrap
      ? null
      : selectedThreadIdForData;
  const remoteBootstrapThreadId =
    shouldDelaySelectedThreadRemoteBootstrap || shouldUseLocalCompleteThreadCache
      ? null
      : selectedThreadIdForData;
  const shouldFetchThreadSnapshot = !shouldUseLocalCompleteThreadCache;
  const isThreadHistoryLocallyComplete = useCallback((threadId: string) => {
    const counts = getThreadCollectionCounts(threadId);
    return getThreadLastAppliedSnapshotKey(threadId) != null
      || (counts != null && (counts.messagesCount > 0 || counts.eventsCount > 0));
  }, []);
  if (selectedThread && selectedWorktreeId && selectedThread.worktreeId === selectedWorktreeId) {
    const selectedThreadAgent = selectedThread.agent ?? "claude";
    lastThreadSelectionRef.current = {
      worktreeId: selectedWorktreeId,
      agent: selectedThreadAgent,
      model: selectedThread.model ?? DEFAULT_CHAT_MODEL_BY_AGENT[selectedThreadAgent],
      modelProviderId: selectedThread.modelProviderId ?? null,
    };
  }
  const fallbackThreadSelection = lastThreadSelectionRef.current?.worktreeId === selectedWorktreeId
    ? lastThreadSelectionRef.current
    : null;
  const composerAgent: CliAgent = selectedThread?.agent ?? fallbackThreadSelection?.agent ?? "claude";
  const composerModel = selectedThread?.model ?? fallbackThreadSelection?.model ?? DEFAULT_CHAT_MODEL_BY_AGENT[composerAgent];
  const composerModelProviderId = selectedThread?.modelProviderId ?? fallbackThreadSelection?.modelProviderId ?? null;
  const composerMode = selectedThreadUiStatus === "review_plan"
    ? "plan"
    : selectedThread?.mode ?? "default";
  const composerPermissionMode = selectedThread?.permissionMode ?? pendingComposerPermissionMode;
  const composerModeLocked = selectedThreadUiStatus !== "idle" && selectedThreadUiStatus !== "running";
  const selectedThreadIsPrMr = !!selectedThreadId && threads.some(
    (thread) => thread.id === selectedThreadId && thread.kind === "review",
  );
  const {
    data: queuedMessages = [],
  } = useQuery({
    queryKey: selectedThreadId ? queryKeys.threads.queue(selectedThreadId) : ["threads", "__no_thread__", "queue"],
    queryFn: () => api.listQueuedMessages(selectedThreadId!),
    enabled: selectedThreadId != null && !shouldDelaySelectedThreadRemoteBootstrap,
  });

  useEffect(() => {
    if (!selectedThreadId || waitingAssistant?.threadId !== selectedThreadId) {
      return;
    }

    if (selectedThread?.active) {
      return;
    }

    if (hasPendingUserGate || hasRunningAssistantActivity(events)) {
      return;
    }

    if (!restoredWaitingThreadIdsRef.current.has(selectedThreadId)) {
      return;
    }

    clearWaitingAssistantForThread(selectedThreadId);
  }, [events, hasPendingUserGate, selectedThread?.active, selectedThreadId, waitingAssistant]);

  const {
    data: queriedThreadSnapshot,
    isLoading: threadSnapshotLoading,
    isFetching: threadSnapshotFetching,
  } = useThreadSnapshot(snapshotBootstrapThreadId, {
    enabled: shouldFetchThreadSnapshot,
  });
  const threadNavigationPerfEnabled = isThreadNavigationPerfEnabled();

  useEffect(() => {
    if (threadNavigationPerfEnabled) {
      return;
    }

    activeThreadNavigationPerfRef.current = null;
  }, [threadNavigationPerfEnabled]);

  useEffect(() => {
    const previousThreadId = previousThreadNavigationPerfThreadIdRef.current;
    if (previousThreadId === selectedThreadId) {
      return;
    }

    previousThreadNavigationPerfThreadIdRef.current = selectedThreadId;

    if (!threadNavigationPerfEnabled || !selectedThreadId) {
      activeThreadNavigationPerfRef.current = null;
      return;
    }

    const session: ThreadNavigationPerfSession = {
      navId: buildThreadNavigationPerfNavId(selectedThreadId),
      threadId: selectedThreadId,
      worktreeId: selectedWorktreeId,
      startedAtMs: getPerfNow(),
      fromThreadId: previousThreadId,
      requestedThreadId,
      snapshotStatusSignature: null,
      renderSignature: null,
      localStateLogged: false,
      readyLogged: false,
    };
    activeThreadNavigationPerfRef.current = session;

    pushThreadNavigationPerf({
      navId: session.navId,
      event: "selection.start",
      threadId: selectedThreadId,
      worktreeId: selectedWorktreeId,
      data: {
        fromThreadId: previousThreadId,
        requestedThreadId,
        localMessageCount: messages.length,
        localEventCount: events.length,
        selectedThreadCreatedLocally,
        shouldDelaySelectedThreadRemoteBootstrap,
        shouldUseLocalCompleteThreadCache,
        snapshotBootstrapThreadId,
        remoteBootstrapThreadId,
        shouldFetchThreadSnapshot,
        snapshotLoading: threadSnapshotLoading,
        snapshotFetching: threadSnapshotFetching,
        hasCachedSnapshot: queriedThreadSnapshot != null,
      },
    });
  }, [
    events.length,
    messages.length,
    queriedThreadSnapshot,
    remoteBootstrapThreadId,
    requestedThreadId,
    selectedThreadCreatedLocally,
    selectedThreadId,
    selectedWorktreeId,
    shouldDelaySelectedThreadRemoteBootstrap,
    shouldFetchThreadSnapshot,
    shouldUseLocalCompleteThreadCache,
    snapshotBootstrapThreadId,
    threadNavigationPerfEnabled,
    threadSnapshotFetching,
    threadSnapshotLoading,
  ]);

  useEffect(() => {
    if (!threadNavigationPerfEnabled) {
      return;
    }

    const session = activeThreadNavigationPerfRef.current;
    if (!session || session.threadId !== selectedThreadId) {
      return;
    }

    const snapshotKey = queriedThreadSnapshot ? buildSnapshotKey(queriedThreadSnapshot) : null;
    const signature = queriedThreadSnapshot
      ? `snapshot:${snapshotKey ?? "unknown"}`
      : `state:${remoteBootstrapThreadId ?? "none"}:${threadSnapshotLoading ? "1" : "0"}:${threadSnapshotFetching ? "1" : "0"}`;

    if (session.snapshotStatusSignature === signature) {
      return;
    }

    session.snapshotStatusSignature = signature;

    if (queriedThreadSnapshot) {
      pushThreadNavigationPerf({
        navId: session.navId,
        event: "snapshot.received",
        threadId: session.threadId,
        worktreeId: selectedWorktreeId,
        data: {
          atMs: getThreadNavigationPerfElapsedMs(session),
          snapshotKey,
          snapshotBootstrapThreadId,
          remoteBootstrapThreadId,
          shouldFetchThreadSnapshot,
          snapshotMessageCount: queriedThreadSnapshot.messages.length,
          snapshotEventCount: queriedThreadSnapshot.events.length,
          snapshotTimelineItemCount: queriedThreadSnapshot.timelineItems.length,
          newestIdx: queriedThreadSnapshot.newestIdx,
          newestSeq: queriedThreadSnapshot.newestSeq,
          snapshotLoading: threadSnapshotLoading,
          snapshotFetching: threadSnapshotFetching,
        },
      });
      return;
    }

    if (!threadSnapshotLoading && !threadSnapshotFetching) {
      return;
    }

    pushThreadNavigationPerf({
      navId: session.navId,
      event: "snapshot.pending",
      threadId: session.threadId,
      worktreeId: selectedWorktreeId,
      data: {
        atMs: getThreadNavigationPerfElapsedMs(session),
        snapshotBootstrapThreadId,
        remoteBootstrapThreadId,
        shouldFetchThreadSnapshot,
        snapshotLoading: threadSnapshotLoading,
        snapshotFetching: threadSnapshotFetching,
      },
    });
  }, [
    threadNavigationPerfEnabled,
    queriedThreadSnapshot,
    remoteBootstrapThreadId,
    selectedThreadId,
    selectedWorktreeId,
    shouldFetchThreadSnapshot,
    snapshotBootstrapThreadId,
    threadSnapshotFetching,
    threadSnapshotLoading,
  ]);

  useEffect(() => {
    const threadChanged = prevSeedThreadRef.current !== selectedThreadId;
    const lastAppliedSnapshotKey = selectedThreadId
      ? getThreadLastAppliedSnapshotKey(selectedThreadId)
      : null;
    const localLatestEventIdx = selectedThreadId
      ? getThreadLastEventIdx(selectedThreadId)
      : null;
    const localLatestMessageSeq = selectedThreadId
      ? getThreadLastMessageSeq(selectedThreadId) ?? messages[messages.length - 1]?.seq ?? null
      : null;
    const seedDecision = resolveSnapshotSeedDecision({
      selectedThreadId,
      queriedThreadSnapshot,
      threadChanged,
      lastAppliedSnapshotKey,
      localLatestEventIdx,
      localLatestMessageSeq,
      waitingForAssistant: waitingAssistant?.threadId === selectedThreadId,
      hasPendingUserGate: !threadChanged && activeThreadIdRef.current === selectedThreadId && hasPendingUserGate,
    });

    if (threadChanged) {
      prevSeedThreadRef.current = selectedThreadId;
    }

    if (!selectedThreadId) {
      return;
    }

    if (!queriedThreadSnapshot || seedDecision.snapshotKey == null) {
      if (threadChanged) {
        setThreadLastAppliedSnapshotKey(selectedThreadId, null);
      }
      return;
    }

    if (!seedDecision.shouldApply) {
      return;
    }

    const snapshotCanAuthoritativelyReplaceLocalState =
      selectedThread?.active !== true
      && waitingAssistant?.threadId !== selectedThreadId
      && !hasPendingUserGate;
    const snapshotCoversLocalHead = doesSnapshotCoverLocalHead({
      snapshot: queriedThreadSnapshot,
      messages,
      events,
    });
    const shouldReplaceSnapshotSeed = (threadChanged && snapshotCoversLocalHead)
      || (queriedThreadSnapshot.messages.length === 0 && queriedThreadSnapshot.events.length === 0)
      || (snapshotCanAuthoritativelyReplaceLocalState && snapshotCoversLocalHead);

    const perfSession = activeThreadNavigationPerfRef.current;
    const hydrateStartedAtMs = getPerfNow();
    const hydrationResult = hydrateThreadFromSnapshot({
      threadId: selectedThreadId,
      snapshot: queriedThreadSnapshot,
      mode: shouldReplaceSnapshotSeed ? "replace" : "merge",
    });
    const hydrateDurationMs = roundPerfMs(getPerfNow() - hydrateStartedAtMs);

    if (threadNavigationPerfEnabled && perfSession?.threadId === selectedThreadId) {
      pushThreadNavigationPerf({
        navId: perfSession.navId,
        event: "snapshot.hydrated",
        threadId: selectedThreadId,
        worktreeId: selectedWorktreeId,
        data: {
          atMs: getThreadNavigationPerfElapsedMs(perfSession),
          durationMs: hydrateDurationMs,
          mode: shouldReplaceSnapshotSeed ? "replace" : "merge",
          seedReason: seedDecision.reason,
          snapshotKey: seedDecision.snapshotKey,
          snapshotCanAuthoritativelyReplaceLocalState,
          localLatestEventIdx,
          localLatestMessageSeq,
          snapshotMessageCount: queriedThreadSnapshot.messages.length,
          snapshotEventCount: queriedThreadSnapshot.events.length,
          hydrationTiming: hydrationResult.timing,
        },
      });
    }

    debugLog("thread.timeline.state", "snapshot.hydrated", {
      threadId: selectedThreadId,
      mode: shouldReplaceSnapshotSeed ? "replace" : "merge",
      seedReason: seedDecision.reason,
      snapshotKey: seedDecision.snapshotKey,
      snapshotMessageCount: queriedThreadSnapshot.messages.length,
      snapshotEventCount: queriedThreadSnapshot.events.length,
      snapshotTimelineItemCount: queriedThreadSnapshot.timelineItems.length,
      snapshotCoversLocalHead,
      localLatestEventIdx,
      localLatestMessageSeq,
      hydrationTiming: hydrationResult.timing,
    });

    const latestMetadata = extractLatestThreadMetadata(queriedThreadSnapshot.events);
    if (latestMetadata.threadTitle) {
      setThreads((current) => applyThreadTitleUpdate(current, selectedThreadId, latestMetadata.threadTitle));
    }
    if (latestMetadata.worktreeBranch && selectedWorktreeId) {
      onBranchRenamed?.(selectedWorktreeId, latestMetadata.worktreeBranch);
    }

    setThreadLastAppliedSnapshotKey(selectedThreadId, seedDecision.snapshotKey);
  }, [
    hasPendingUserGate,
    messages,
    onBranchRenamed,
    queriedThreadSnapshot,
    selectedThread?.active,
    selectedThreadId,
    selectedWorktreeId,
    threadNavigationPerfEnabled,
    waitingAssistant,
  ]);

  useEffect(() => {
    pruneThreadCollections({
      activeThreadId: selectedThreadIdForData,
      retainThreadIds: closingThreadId ? [closingThreadId] : [],
    });
  }, [closingThreadId, selectedThreadIdForData]);

  function clearThreadTrackingState(threadId: string) {
    loggedOrphanEventIdsByThreadRef.current.delete(threadId);
    const claimedKeyPrefix = `${threadId}:`;
    for (const key of claimedContextEventIdsByThreadMessageRef.current.keys()) {
      if (key.startsWith(claimedKeyPrefix)) {
        claimedContextEventIdsByThreadMessageRef.current.delete(key);
      }
    }
    clearThreadStreamState(threadId);
    disposeThreadCollections(threadId);
  }

  function startWaitingAssistant(threadId: string, options?: { restored?: boolean }) {
    if (options?.restored) {
      restoredWaitingThreadIdsRef.current.add(threadId);
    } else {
      restoredWaitingThreadIdsRef.current.delete(threadId);
    }

    const afterIdx = getThreadLastEventIdx(threadId) ?? -1;
    setWaitingAssistant({ threadId, afterIdx });
  }

  function clearWaitingAssistantForThread(threadId: string) {
    restoredWaitingThreadIdsRef.current.delete(threadId);
    setWaitingAssistant((current) => (current?.threadId === threadId ? null : current));
  }

  function reconcileInactiveThread(threadId: string) {
    clearWaitingAssistantForThread(threadId);
    setThreads((current) => applyThreadActiveUpdate(current, threadId, false));

    if (selectedWorktreeId) {
      queryClient.setQueryData<ChatThread[] | undefined>(
        queryKeys.threads.list(selectedWorktreeId),
        (current) => current ? applyThreadActiveUpdate(current, threadId, false) : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(selectedWorktreeId) });
    }

    void queryClient.invalidateQueries({ queryKey: queryKeys.threads.timelineSnapshot(threadId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.threads.statusSnapshot(threadId) });
  }

  function invalidateRepositoryReviews() {
    if (!repositoryId) {
      return;
    }

    void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.reviews(repositoryId) });
  }

  function buildOptimisticAttachments(
    messageId: string,
    attachments: Array<AttachmentInput & { sizeBytes?: number }>,
  ): ChatAttachment[] {
    const createdAt = new Date().toISOString();

    return attachments.map((attachment, index) => ({
      id: attachment.id ?? `optimistic-attachment:${messageId}:${index}`,
      messageId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes ?? attachment.content.length,
      content: attachment.content,
      storagePath: null,
      source: attachment.source,
      createdAt,
    }));
  }

  function createOptimisticUserMessage(params: {
    threadId: string;
    content: string;
    attachments: Array<AttachmentInput & { sizeBytes?: number }>;
    force?: boolean;
  }): ChatMessage {
    const { threadId, content, attachments, force = false } = params;
    const messageId = `optimistic-user:${threadId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    const baseMessages =
      force && activeThreadIdRef.current !== threadId
        ? []
        : getThreadMessagesCollection(threadId).toArray as ChatMessage[];
    const nextSeq = allocateNextThreadMessageSeq(
      threadId,
      baseMessages[baseMessages.length - 1]?.seq ?? null,
    );

    return {
      id: messageId,
      threadId,
      seq: nextSeq,
      role: "user",
      content,
      attachments: buildOptimisticAttachments(messageId, attachments),
      createdAt: new Date().toISOString(),
    };
  }

  function insertOptimisticUserMessage(
    optimisticMessage: ChatMessage,
    options?: { force?: boolean },
  ) {
    if (!options?.force && activeThreadIdRef.current !== optimisticMessage.threadId) {
      return;
    }

    const messagesCollection = getThreadMessagesCollection(optimisticMessage.threadId);
    const currentMessages = messagesCollection.toArray as ChatMessage[];
    if (currentMessages.some((message) => message.id === optimisticMessage.id)) {
      return;
    }

    messagesCollection.insert(optimisticMessage);
    setThreadLastMessageSeq(optimisticMessage.threadId, optimisticMessage.seq);
  }

  function removeOptimisticMessage(threadId: string, optimisticMessageId: string, options?: { force?: boolean }) {
    if (!options?.force && activeThreadIdRef.current !== threadId) {
      return;
    }

    const messagesCollection = getThreadMessagesCollection(threadId);
    const currentMessages = messagesCollection.toArray as ChatMessage[];
    if (!currentMessages.some((message) => message.id === optimisticMessageId)) {
      return;
    }

    messagesCollection.delete(optimisticMessageId);
  }

  function mergeReturnedMessageIntoVisibleState(
    threadId: string,
    sentMessage: ChatMessage,
    options?: { force?: boolean; optimisticMessageId?: string },
  ) {
    if (!options?.force && activeThreadIdRef.current !== threadId) {
      return;
    }

    const messagesCollection = getThreadMessagesCollection(threadId);
    if (options?.optimisticMessageId && messagesCollection.toArray.some((message) => message.id === options.optimisticMessageId)) {
      messagesCollection.delete(options.optimisticMessageId);
    }

    const existingMessages = messagesCollection.toArray as ChatMessage[];
    const existingMessage = existingMessages.find((message) => message.id === sentMessage.id) ?? null;
    if (!existingMessage) {
      messagesCollection.insert(sentMessage);
      setThreadLastMessageSeq(threadId, sentMessage.seq);
      return;
    }

    if (areMessagesEqual(existingMessage, sentMessage)) {
      return;
    }

    messagesCollection.update(sentMessage.id, (draft) => {
      Object.assign(draft, sentMessage);
    });
    setThreadLastMessageSeq(threadId, sentMessage.seq);
  }

  function syncThreadIntoCache(worktreeId: string, thread: ChatThread) {
    queryClient.setQueryData<ChatThread[] | undefined>(queryKeys.threads.list(worktreeId), (current) => {
      if (!current) {
        return [thread];
      }

      const existingIndex = current.findIndex((entry) => entry.id === thread.id);
      if (existingIndex === -1) {
        return [...current, thread];
      }

      const updated = [...current];
      updated[existingIndex] = thread;
      return updated;
    });
  }

  useEffect(() => {
    const selectionBootstrapPending = selectedThreadId == null && requestedThreadId != null;
    if (selectionBootstrapPending) {
      return;
    }

    const willNotify = prevThreadIdRef.current !== selectedThreadId;
    if (willNotify) {
      prevThreadIdRef.current = selectedThreadId;
      options?.onThreadChange?.(selectedThreadId);
    }
  }, [requestedThreadId, selectedThreadId]);

  useThreadEventStream({
    selectedThreadId: remoteBootstrapThreadId,
    selectedWorktreeId,
    repositoryId,
    selectedThreadIsPrMr,
    locallyDeletedThreadIdsRef,
    activeThreadIdRef,
    setThreads,
    setWaitingAssistant,
    setStoppingThreadId,
    setStopRequestedThreadId,
    streamingMessageIdsRef,
    stickyRawFallbackMessageIdsRef,
    renderDecisionByMessageIdRef,
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

  async function createThreadInCurrentContext(
    title: string,
    options?: { reuseExisting?: boolean; sendDefaultTitle?: boolean },
  ): Promise<{ created: ChatThread; worktreeId: string } | null> {
    if (!selectedWorktreeId) {
      return null;
    }

    const trimmedTitle = title.trim();
    if (options?.reuseExisting) {
      const existingThread = threadsRef.current.find((thread) => thread.title.trim() === trimmedTitle) ?? null;
      if (existingThread) {
        return { created: existingThread, worktreeId: selectedWorktreeId };
      }
    }

    const selectionInput = buildThreadSelectionInput(
      findThreadForWorktree(threadsRef.current, activeThreadIdRef.current, selectedWorktreeId),
    );

    const created = options?.sendDefaultTitle === false
      ? await api.createThread(selectedWorktreeId, {
          permissionMode: composerPermissionMode,
          ...selectionInput,
        })
      : await api.createThread(selectedWorktreeId, {
          title: trimmedTitle,
          permissionMode: composerPermissionMode,
          ...selectionInput,
        });
    return { created, worktreeId: selectedWorktreeId };
  }

  async function createAdditionalThread() {
    onError(null);
    try {
      const result = await createThreadInCurrentContext(DEFAULT_THREAD_TITLE);
      if (!result) return null;
      const { created, worktreeId } = result;
      optimisticCreatedThreadIdsRef.current.add(created.id);
      activeThreadIdRef.current = created.id;
      setThreads((current) => {
        if (current.some((t) => t.id === created.id)) return current;
        locallyDeletedThreadIdsRef.current.delete(created.id);
        return [...current, created];
      });
      setSelectedThreadId(created.id);
      syncThreadIntoCache(worktreeId, created);
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
      const result = await createThreadInCurrentContext(title, { reuseExisting: true });
      if (!result) return;
      const { created, worktreeId } = result;
      optimisticCreatedThreadIdsRef.current.add(created.id);
      activeThreadIdRef.current = created.id;
      setThreads((current) => {
        if (current.some((t) => t.id === created.id)) return current;
        locallyDeletedThreadIdsRef.current.delete(created.id);
        return [...current, created];
      });
      setSelectedThreadId(created.id);
      syncThreadIntoCache(worktreeId, created);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(worktreeId) });
      startWaitingAssistant(created.id);
      setSendingMessage(true);
      const optimisticMessage = createOptimisticUserMessage({
        threadId: created.id,
        content,
        attachments: [],
        force: true,
      });
      insertOptimisticUserMessage(optimisticMessage, { force: true });
      try {
        setThreads((current) => applyThreadModeUpdate(current, created.id, mode));
        queryClient.setQueryData<ChatThread[] | undefined>(
          queryKeys.threads.list(worktreeId),
          (current) => current ? applyThreadModeUpdate(current, created.id, mode) : current,
        );
        const sentMessage = await api.sendMessage(created.id, {
          content,
          mode,
          attachments: [],
          expectedWorktreeId: worktreeId,
        });
        mergeReturnedMessageIntoVisibleState(created.id, sentMessage, {
          force: true,
          optimisticMessageId: optimisticMessage.id,
        });
      } catch (e) {
        removeOptimisticMessage(created.id, optimisticMessage.id, { force: true });
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
    let optimisticMessageId: string | null = null;
    let createdThreadId: string | null = null;
    try {
      const created = await api.getOrCreatePrMrThread(selectedWorktreeId, {
        permissionMode: composerPermissionMode,
        ...buildThreadSelectionInput(
          findThreadForWorktree(threadsRef.current, activeThreadIdRef.current, selectedWorktreeId),
        ),
      });
      createdThreadId = created.id;
      optimisticCreatedThreadIdsRef.current.add(created.id);
      activeThreadIdRef.current = created.id;
      setThreads((current) => {
        const existingIndex = current.findIndex((thread) => thread.id === created.id);
        locallyDeletedThreadIdsRef.current.delete(created.id);
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
      const optimisticMessage = createOptimisticUserMessage({
        threadId: created.id,
        content,
        attachments: [],
        force: true,
      });
      optimisticMessageId = optimisticMessage.id;
      insertOptimisticUserMessage(optimisticMessage, { force: true });
      setThreads((current) => applyThreadModeUpdate(current, created.id, mode));
      queryClient.setQueryData<ChatThread[] | undefined>(
        queryKeys.threads.list(selectedWorktreeId),
        (current) => current ? applyThreadModeUpdate(current, created.id, mode) : current,
      );
      const sentMessage = await api.sendMessage(created.id, {
        content,
        mode,
        attachments: [],
        expectedWorktreeId: created.worktreeId,
      });
      mergeReturnedMessageIntoVisibleState(created.id, sentMessage, {
        force: true,
        optimisticMessageId: optimisticMessage.id,
      });
      invalidateRepositoryReviews();
      return created;
    } catch (e) {
      if (createdThreadId && optimisticMessageId) {
        removeOptimisticMessage(createdThreadId, optimisticMessageId, { force: true });
      }
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
    const currentThreads = threadsRef.current;
    const closedThreadWasPrMr = currentThreads.some((thread) => thread.id === threadId && thread.kind === "review");
    const wasSelected = activeThreadIdRef.current === threadId;
    const previousSelectedThreadId = activeThreadIdRef.current;
    const updatedThreads = currentThreads.filter((thread) => thread.id !== threadId);
    const nextThreadId = wasSelected ? resolvePreferredThreadId(updatedThreads) : previousSelectedThreadId;

    locallyDeletedThreadIdsRef.current.add(threadId);
    setThreads(updatedThreads);

    if (selectedWorktreeId) {
      queryClient.setQueryData<ChatThread[] | undefined>(
        queryKeys.threads.list(selectedWorktreeId),
        updatedThreads,
      );
    }

    if (wasSelected) {
      setWaitingAssistant(null);
      setSelectedThreadId(nextThreadId);
    }

    try {
      await queryClient.cancelQueries({ queryKey: queryKeys.threads.timelineSnapshot(threadId) });
      await queryClient.cancelQueries({ queryKey: queryKeys.threads.messages(threadId) });
      await queryClient.cancelQueries({ queryKey: queryKeys.threads.events(threadId) });
      queryClient.removeQueries({ queryKey: queryKeys.threads.timelineSnapshot(threadId) });
      queryClient.removeQueries({ queryKey: queryKeys.threads.messages(threadId) });
      queryClient.removeQueries({ queryKey: queryKeys.threads.events(threadId) });
      await api.deleteThread(threadId);

      if (selectedWorktreeId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(selectedWorktreeId) });
      }
      if (closedThreadWasPrMr) {
        invalidateRepositoryReviews();
      }
      clearThreadTrackingState(threadId);
    } catch (e) {
      locallyDeletedThreadIdsRef.current.delete(threadId);
      setThreads(currentThreads);
      if (selectedWorktreeId) {
        queryClient.setQueryData<ChatThread[] | undefined>(
          queryKeys.threads.list(selectedWorktreeId),
          currentThreads,
        );
      }
      if (wasSelected) {
        setSelectedThreadId(previousSelectedThreadId);
      }
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
    const currentThread = threadByIdRef.current.get(threadId) ?? null;
    if (currentThread?.mode === mode) {
      return;
    }

    onError(null);
    const previousThreads = threads;
    const cacheWorktreeId = selectedWorktreeId ?? (threadByIdRef.current.get(threadId)?.worktreeId ?? null);

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

  async function setThreadAgentSelection(threadId: string, selection: UpdateChatThreadAgentSelectionInput) {
    const previousPendingUpdate = pendingAgentSelectionUpdatesRef.current.get(threadId);
    const mutationPromise = (previousPendingUpdate ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const currentThread = threadByIdRef.current.get(threadId) ?? null;
        if (
          currentThread?.agent === selection.agent
          && currentThread.model === selection.model
          && currentThread.modelProviderId === (selection.modelProviderId ?? null)
        ) {
          return;
        }

        onError(null);
        const previousThreads = threadsRef.current;
        const cacheWorktreeId = selectedWorktreeId ?? (currentThread?.worktreeId ?? null);

        setThreads((current) => applyThreadAgentSelectionUpdate(current, threadId, selection));
        if (cacheWorktreeId) {
          queryClient.setQueryData<ChatThread[] | undefined>(
            queryKeys.threads.list(cacheWorktreeId),
            (current) => current ? applyThreadAgentSelectionUpdate(current, threadId, selection) : current,
          );
        }

        try {
          const updated = await api.updateThreadAgentSelection(threadId, selection);
          setThreads((current) => replaceThread(current, updated));
          const updatedCacheWorktreeId = selectedWorktreeId ?? updated.worktreeId;
          if (updatedCacheWorktreeId) {
            queryClient.setQueryData<ChatThread[] | undefined>(
              queryKeys.threads.list(updatedCacheWorktreeId),
              (current) => current ? replaceThread(current, updated) : current,
            );
          }
        } catch (e) {
          setThreads(previousThreads);
          if (cacheWorktreeId) {
            queryClient.setQueryData<ChatThread[] | undefined>(queryKeys.threads.list(cacheWorktreeId), previousThreads);
          }
          onError(e instanceof Error ? e.message : "Failed to update thread agent selection");
        }
      });

    pendingAgentSelectionUpdatesRef.current.set(threadId, mutationPromise);

    try {
      await mutationPromise;
    } finally {
      if (pendingAgentSelectionUpdatesRef.current.get(threadId) === mutationPromise) {
        pendingAgentSelectionUpdatesRef.current.delete(threadId);
      }
    }
  }

  async function setComposerPermissionMode(permissionMode: ChatThreadPermissionMode) {
    const normalizedMode = permissionMode === "full_access" ? "full_access" : "default";
    const activeThread = findThreadForWorktree(
      threadsRef.current,
      activeThreadIdRef.current,
      selectedWorktreeId,
    );

    if (!activeThread) {
      setPendingComposerPermissionMode(normalizedMode);
      return;
    }

    if (activeThread.permissionMode === normalizedMode) {
      return;
    }

    onError(null);
    const previousThreads = threads;
    const cacheWorktreeId = selectedWorktreeId ?? activeThread.worktreeId;

    setThreads((current) => applyThreadPermissionModeUpdate(current, activeThread.id, normalizedMode));
    if (cacheWorktreeId) {
      queryClient.setQueryData<ChatThread[] | undefined>(
        queryKeys.threads.list(cacheWorktreeId),
        (current) => current ? applyThreadPermissionModeUpdate(current, activeThread.id, normalizedMode) : current,
      );
    }

    try {
      const updated = await api.updateThreadPermissionMode(activeThread.id, { permissionMode: normalizedMode });
      setThreads((current) => applyThreadPermissionModeUpdate(current, updated.id, updated.permissionMode));
      const updatedCacheWorktreeId = selectedWorktreeId ?? updated.worktreeId;
      if (updatedCacheWorktreeId) {
        queryClient.setQueryData<ChatThread[] | undefined>(
          queryKeys.threads.list(updatedCacheWorktreeId),
          (current) => current ? applyThreadPermissionModeUpdate(current, updated.id, updated.permissionMode) : current,
        );
      }
    } catch (e) {
      setThreads(previousThreads);
      if (cacheWorktreeId) {
        queryClient.setQueryData<ChatThread[] | undefined>(queryKeys.threads.list(cacheWorktreeId), previousThreads);
      }
      onError(e instanceof Error ? e.message : "Failed to update thread permission mode");
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

    const threadId = activeThreadIdRef.current;
    if (!threadId || (!content.trim() && attachmentsToSend.length === 0)) return false;

    const pendingAgentSelectionUpdate = pendingAgentSelectionUpdatesRef.current.get(threadId);
    if (pendingAgentSelectionUpdate) {
      await pendingAgentSelectionUpdate;
    }

    const activeThread = findThreadForWorktree(threadsRef.current, threadId, selectedWorktreeId);
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
    const optimisticMessage = createOptimisticUserMessage({
      threadId: activeThread.id,
      content,
      attachments: messageAttachments,
    });
    insertOptimisticUserMessage(optimisticMessage);

    try {
      setThreads((current) => applyThreadModeUpdate(current, activeThread.id, mode));
      if (selectedWorktreeId) {
        queryClient.setQueryData<ChatThread[] | undefined>(
          queryKeys.threads.list(selectedWorktreeId),
          (current) => current ? applyThreadModeUpdate(current, activeThread.id, mode) : current,
        );
      }
      const sentMessage = await api.sendMessage(activeThread.id, {
        content,
        mode,
        attachments: attachmentsToSend,
        expectedWorktreeId: activeThread.worktreeId,
      });
      mergeReturnedMessageIntoVisibleState(activeThread.id, sentMessage, {
        optimisticMessageId: optimisticMessage.id,
      });
      if (shouldInvalidateSnapshot) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.threads.timelineSnapshot(activeThread.id) });
      }
      return true;
    } catch (e) {
      removeOptimisticMessage(activeThread.id, optimisticMessage.id);
      setWaitingAssistant(null);
      onError(e instanceof Error ? e.message : "Failed to send message");
      return false;
    } finally {
      setSendingMessage(false);
    }
  }

  async function setComposerMode(mode: ChatMode) {
    const threadId = activeThreadIdRef.current;
    if (!threadId) {
      return;
    }

    await setThreadMode(threadId, mode);
  }

  async function setComposerAgentSelection(selection: UpdateChatThreadAgentSelectionInput) {
    const threadId = activeThreadIdRef.current;
    if (!threadId) {
      return;
    }

    await setThreadAgentSelection(threadId, selection);
  }

  async function stopAssistantRun(targetThreadId?: string) {
    const threadId = targetThreadId ?? selectedThreadId;
    if (!threadId) return;
    if (stopRequestedThreadId === threadId) return;

    setStopRequestedThreadId(threadId);
    setStoppingThreadId(threadId);
    onError(null);

    try {
      await api.stopRun(threadId);
    } catch (e) {
      if (e instanceof Error && e.message === "No active assistant run for this thread") {
        reconcileInactiveThread(threadId);
        setStopRequestedThreadId((current) => (current === threadId ? null : current));
        return;
      }

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

  async function queueDraft(
    content: string,
    mode: ChatMode,
    messageAttachments: Array<AttachmentInput & { sizeBytes?: number; isInline?: boolean }>,
  ) {
    const threadId = activeThreadIdRef.current;
    if (!threadId) {
      return false;
    }

    const activeThread = findThreadForWorktree(threadsRef.current, threadId, selectedWorktreeId);
    if (!activeThread) {
      onError("Selected thread is stale for the active worktree. Please retry.");
      return false;
    }

    const attachmentsToSend: AttachmentInput[] = messageAttachments.map((att) => ({
      id: att.id,
      filename: att.filename,
      mimeType: att.mimeType,
      content: att.content,
      source: att.source,
    }));

    onError(null);
    try {
      const queuedMessage = await api.queueMessage(activeThread.id, {
        content,
        mode,
        attachments: attachmentsToSend,
        expectedWorktreeId: activeThread.worktreeId,
      });
      queryClient.setQueryData<ChatQueuedMessage[]>(
        queryKeys.threads.queue(activeThread.id),
        (current) => upsertQueuedMessage(current, queuedMessage),
      );
      if (!shouldDelaySelectedThreadRemoteBootstrap) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.threads.queue(activeThread.id) });
      }
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to queue draft");
      return false;
    }
  }

  async function deleteQueuedDraft(queueMessageId: string) {
    if (!selectedThreadId) {
      return;
    }

    const previousQueue = queryClient.getQueryData<ChatQueuedMessage[]>(queryKeys.threads.queue(selectedThreadId)) ?? [];
    queryClient.setQueryData<ChatQueuedMessage[]>(
      queryKeys.threads.queue(selectedThreadId),
      previousQueue.filter((message) => message.id !== queueMessageId),
    );

    try {
      await api.deleteQueuedMessage(selectedThreadId, queueMessageId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.queue(selectedThreadId) });
    } catch (error) {
      queryClient.setQueryData(queryKeys.threads.queue(selectedThreadId), previousQueue);
      onError(error instanceof Error ? error.message : "Failed to delete queued draft");
    }
  }

  async function updateQueuedDraft(queueMessageId: string, content: string) {
    if (!selectedThreadId) {
      return false;
    }

    const previousQueue = queryClient.getQueryData<ChatQueuedMessage[]>(queryKeys.threads.queue(selectedThreadId)) ?? [];
    queryClient.setQueryData<ChatQueuedMessage[]>(
      queryKeys.threads.queue(selectedThreadId),
      previousQueue.map((message) => message.id === queueMessageId
        ? {
          ...message,
          content,
        }
        : message),
    );

    try {
      await api.updateQueuedMessage(selectedThreadId, queueMessageId, { content });
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.queue(selectedThreadId) });
      return true;
    } catch (error) {
      queryClient.setQueryData(queryKeys.threads.queue(selectedThreadId), previousQueue);
      onError(error instanceof Error ? error.message : "Failed to update queued draft");
      return false;
    }
  }

  async function dispatchQueuedDraft(queueMessageId: string) {
    if (!selectedThreadId) {
      return;
    }

    const previousQueue = queryClient.getQueryData<ChatQueuedMessage[]>(queryKeys.threads.queue(selectedThreadId)) ?? [];
    queryClient.setQueryData<ChatQueuedMessage[]>(
      queryKeys.threads.queue(selectedThreadId),
      previousQueue.map((message) => message.id === queueMessageId
        ? {
          ...message,
          status: message.status === "dispatching" ? "dispatching" : "dispatch_requested",
          dispatchRequestedAt: message.dispatchRequestedAt ?? new Date().toISOString(),
        }
        : message),
    );

    try {
      await api.requestQueuedMessageDispatch(selectedThreadId, queueMessageId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.queue(selectedThreadId) });
    } catch (error) {
      queryClient.setQueryData(queryKeys.threads.queue(selectedThreadId), previousQueue);
      onError(error instanceof Error ? error.message : "Failed to dispatch queued draft");
    }
  }

  const serverTimelineItems = (queriedThreadSnapshot?.timelineItems ?? []) as unknown as ChatTimelineItem[];
  const serverTimelineSummary = queriedThreadSnapshot?.summary as ChatTimelineSummary | undefined;
  const timelineSeedMatchesLiveState = useMemo(
    () => selectedThreadId != null && doesSnapshotMatchLocalLiveState({
      snapshot: queriedThreadSnapshot,
      messages,
      events,
    }),
    [events, messages, queriedThreadSnapshot, selectedThreadId],
  );
  const serverSnapshotCoversLocalHead = useMemo(
    () => doesSnapshotCoverLocalHead({
      snapshot: queriedThreadSnapshot,
      messages,
      events,
    }),
    [events, messages, queriedThreadSnapshot],
  );
  const serverTimelineFreshEnough = isSnapshotFreshEnoughForAuthoritativeTimeline({
    snapshot: queriedThreadSnapshot,
    messages,
    events,
  });
  const serverSnapshotContainsCanonicalState = hasCanonicalThreadSnapshot(queriedThreadSnapshot);
  const selectedThreadStableForAuthoritativeTimeline =
    waitingAssistant?.threadId !== selectedThreadId
    && !sendingMessage
    && (
      selectedThreadUiStatus === "idle"
      || selectedThreadUiStatus === "review_plan"
      || selectedThreadUiStatus === "waiting_approval"
    );
  const preferServerTimeline =
    timelineEnabled
    && serverTimelineSummary != null
    && (
      timelineSeedMatchesLiveState
      || (selectedThreadStableForAuthoritativeTimeline && serverTimelineFreshEnough && serverSnapshotCoversLocalHead)
    );
  const skipDerivedTimeline =
    preferServerTimeline
    && (
      serverSnapshotContainsCanonicalState
      || queriedThreadSnapshot?.collectionsIncluded === false
    );
  const timelineRefs = useMemo(() => ({
    streamingMessageIds: streamingMessageIdsRef.current,
    stickyRawFallbackMessageIds: stickyRawFallbackMessageIdsRef.current,
    renderDecisionByMessageId: renderDecisionByMessageIdRef.current,
    loggedOrphanEventIdsByThread: loggedOrphanEventIdsByThreadRef.current,
    claimedContextEventIdsByThreadMessage: claimedContextEventIdsByThreadMessageRef.current,
  }), []);

  const derivedTimelineStartedAtMs = threadNavigationPerfEnabled ? getPerfNow() : 0;
  const derivedTimeline = useWorkspaceTimeline(messages, events, selectedThreadId, timelineRefs, {
    semanticHydrationInProgress: false,
    disabled: !timelineEnabled || skipDerivedTimeline,
  });
  const derivedTimelineDurationMs = threadNavigationPerfEnabled
    ? roundPerfMs(getPerfNow() - derivedTimelineStartedAtMs)
    : 0;

  const timelineComparison = useMemo(() => {
    const server = summarizeTimelineItems(serverTimelineItems);
    if (skipDerivedTimeline) {
      return {
        server,
        derived: {
          total: 0,
          signatures: [],
          kinds: {},
          exploreCards: 0,
          emptyExploreCards: 0,
          subagentCards: 0,
          subagentsMissingDescription: 0,
        },
        hasSuspiciousSubagentOrExploreState: server.exploreCards > 0 || server.subagentCards > 0,
        signaturesMatch: true,
        preferDerivedBecauseServerLooksStale: false,
      };
    }

    const derived = summarizeTimelineItems(derivedTimeline.items);
    const hasSuspiciousSubagentOrExploreState =
      server.exploreCards > 0
      || derived.exploreCards > 0
      || server.subagentCards > 0
      || derived.subagentCards > 0;
    const signaturesMatch = JSON.stringify(server.signatures) === JSON.stringify(derived.signatures);
    const preferDerivedBecauseServerLooksStale =
      queriedThreadSnapshot?.collectionsIncluded !== false
      && !serverSnapshotContainsCanonicalState
      && derivedTimeline.items.length === 0
      && serverTimelineItems.length > 0;

    return {
      server,
      derived,
      hasSuspiciousSubagentOrExploreState,
      signaturesMatch,
      preferDerivedBecauseServerLooksStale,
    };
  }, [derivedTimeline.items, queriedThreadSnapshot, serverTimelineItems, skipDerivedTimeline]);

  const useServerTimeline = preferServerTimeline
    && !timelineComparison.preferDerivedBecauseServerLooksStale;

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
        serverTimelineFreshEnough,
        selectedThreadStableForAuthoritativeTimeline,
        useServerTimeline,
        signaturesMatch: timelineComparison.signaturesMatch,
        preferDerivedBecauseServerLooksStale: timelineComparison.preferDerivedBecauseServerLooksStale,
        server: timelineComparison.server,
        derived: timelineComparison.derived,
      },
    });
  }, [
    selectedThreadId,
    timelineComparison,
    timelineEnabled,
    timelineSeedMatchesLiveState,
    serverTimelineFreshEnough,
    selectedThreadStableForAuthoritativeTimeline,
    useServerTimeline,
  ]);

  const timelineItems = timelineData.items;
  const timelineSummary = timelineData.summary;
  const requestedThreadBootstrapPending =
    selectedThreadId == null
    && options?.desiredThreadId != null;
  const selectedExistingThreadBootstrapPending =
    selectedThreadId != null
    && !selectedThreadCreatedLocally
    && !selectedThreadHasLocalState
    && queriedThreadSnapshot == null;
  const messageListEmptyState:
    | "no-thread-selected"
    | "creating-thread"
    | "loading-thread"
    | "new-thread-empty"
    | "existing-thread-empty"
    | null =
    timelineItems.length > 0
      ? null
      : selectedThreadId == null
        ? selectedWorktreeId && queriedThreads?.length === 0
          ? "creating-thread"
          : requestedThreadBootstrapPending
            ? "loading-thread"
            : "no-thread-selected"
        : selectedThreadCreatedLocally
          ? "new-thread-empty"
          : (
            threadSnapshotLoading
            || (threadSnapshotFetching && queriedThreadSnapshot == null)
            || selectedExistingThreadBootstrapPending
          ) && !selectedThreadHasLocalState
            ? "loading-thread"
            : "existing-thread-empty";

  useEffect(() => {
    if (!threadNavigationPerfEnabled) {
      return;
    }

    const session = activeThreadNavigationPerfRef.current;
    if (!session || session.threadId !== selectedThreadId) {
      return;
    }

    if (session.localStateLogged || (messages.length === 0 && events.length === 0)) {
      return;
    }

    session.localStateLogged = true;
    pushThreadNavigationPerf({
      navId: session.navId,
      event: "local-state.available",
      threadId: session.threadId,
      worktreeId: selectedWorktreeId,
      data: {
        atMs: getThreadNavigationPerfElapsedMs(session),
        localMessageCount: messages.length,
        localEventCount: events.length,
        newestMessageSeq: messages[messages.length - 1]?.seq ?? null,
        newestEventIdx: events[events.length - 1]?.idx ?? null,
      },
    });
  }, [events, messages, selectedThreadId, selectedWorktreeId, threadNavigationPerfEnabled]);

  useEffect(() => {
    if (!threadNavigationPerfEnabled) {
      return;
    }

    const session = activeThreadNavigationPerfRef.current;
    if (!session || session.threadId !== selectedThreadId) {
      return;
    }

    const nextRenderSignature = [
      messageListEmptyState ?? "ready",
      timelineItems.length,
      useServerTimeline ? "server" : "derived",
      derivedTimeline.items.length,
      serverTimelineItems.length,
      messages.length,
      events.length,
    ].join("|");

    if (session.renderSignature === nextRenderSignature) {
      return;
    }

    session.renderSignature = nextRenderSignature;
    pushThreadNavigationPerf({
      navId: session.navId,
      event: "timeline.state",
      threadId: session.threadId,
      worktreeId: selectedWorktreeId,
      data: {
        atMs: getThreadNavigationPerfElapsedMs(session),
        messageListEmptyState,
        timelineItemsCount: timelineItems.length,
        derivedTimelineItemsCount: derivedTimeline.items.length,
        serverTimelineItemsCount: serverTimelineItems.length,
        useServerTimeline,
        derivedTimelineDurationMs,
        composerDisabled,
        selectedThreadUiStatus,
        threadSnapshotLoading,
        threadSnapshotFetching,
      },
    });
  }, [
    composerDisabled,
    derivedTimeline.items.length,
    derivedTimelineDurationMs,
    events.length,
    messageListEmptyState,
    messages.length,
    selectedThreadId,
    selectedThreadUiStatus,
    selectedWorktreeId,
    serverTimelineItems.length,
    threadSnapshotFetching,
    threadSnapshotLoading,
    timelineItems.length,
    threadNavigationPerfEnabled,
    useServerTimeline,
  ]);

  const threadNavigationReady =
    selectedThreadId != null
    && !composerDisabled
    && messageListEmptyState !== "loading-thread"
    && messageListEmptyState !== "creating-thread"
    && messageListEmptyState !== "no-thread-selected";

  useEffect(() => {
    if (!threadNavigationPerfEnabled) {
      return;
    }

    const session = activeThreadNavigationPerfRef.current;
    if (!session || session.threadId !== selectedThreadId || session.readyLogged || !threadNavigationReady) {
      return;
    }

    session.readyLogged = true;
    pushThreadNavigationPerf({
      navId: session.navId,
      event: "thread.ready",
      threadId: session.threadId,
      worktreeId: selectedWorktreeId,
      data: {
        totalMs: getThreadNavigationPerfElapsedMs(session),
        messageListEmptyState,
        timelineItemsCount: timelineItems.length,
        useServerTimeline,
        derivedTimelineDurationMs,
        localMessageCount: messages.length,
        localEventCount: events.length,
        queuedMessageCount: queuedMessages.length,
        selectedThreadUiStatus,
      },
    });
  }, [
    derivedTimelineDurationMs,
    events.length,
    messageListEmptyState,
    messages.length,
    queuedMessages.length,
    selectedThreadId,
    selectedThreadUiStatus,
    selectedWorktreeId,
    threadNavigationReady,
    threadNavigationPerfEnabled,
    timelineItems.length,
    useServerTimeline,
  ]);

  return {
    threads,
    selectedThreadId,
    selectedThreadIdForData,
    setSelectedThreadId,
    messages,
    events,
    closingThreadId,

    sendingMessage,
    waitingAssistant,
    selectedThreadUiStatus,
    queuedMessages,
    composerAgent,
    composerModel,
    composerModelProviderId,
    composerMode,
    composerPermissionMode,
    composerModeLocked,
    composerDisabled,
    showStopAction,
    stoppingRun,
    isThreadHistoryLocallyComplete,
    semanticHydrationInProgress: false,

    timelineItems,
    timelineSummary,
    messageListEmptyState,

    createAdditionalThread,
    createThreadAndSendMessage,
    createOrSelectPrMrThreadAndSendMessage,
    closeThread,
    renameThreadTitle,
    setThreadAgentSelection,
    setThreadMode,
    setComposerAgentSelection,
    setComposerMode,
    setComposerPermissionMode,
    submitMessage,
    queueDraft,
    updateQueuedDraft,
    deleteQueuedDraft,
    dispatchQueuedDraft,
    stopAssistantRun,

    startWaitingAssistant,
    clearWaitingAssistantForThread,
  };
}
