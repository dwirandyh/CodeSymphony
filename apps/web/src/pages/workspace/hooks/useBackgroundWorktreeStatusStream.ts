import { useEffect, useMemo, useRef } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type { MutableRefObject } from "react";
import type { ChatEvent, ChatThread, ChatThreadSnapshot, Repository } from "@codesymphony/shared-types";
import { api } from "../../../lib/api";
import { queryKeys } from "../../../lib/queryKeys";
import { EVENT_TYPES } from "../constants";
import { GIT_STATUS_INVALIDATION_EVENT_TYPES, payloadStringOrNull } from "../eventUtils";
import { applyThreadTitleUpdate } from "./chat-session/snapshotSeed";
import { SNAPSHOT_INVALIDATION_EVENT_TYPES } from "./snapshotInvalidationEventTypes";

const LIVE_ACTIVITY_EVENT_TYPES = new Set<ChatEvent["type"]>([
  "message.delta",
  "thinking.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "permission.requested",
  "question.requested",
  "plan.created",
]);

const TERMINAL_EVENT_TYPES = new Set<ChatEvent["type"]>(["chat.completed", "chat.failed"]);

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1000;

type ThreadStreamState = {
  stream: EventSource;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  stopped: boolean;
  stopRetrying: boolean;
};

function ensureSeenEventIds(
  seenEventIdsByThreadRef: MutableRefObject<Map<string, Set<string>>>,
  threadId: string,
): Set<string> {
  const existing = seenEventIdsByThreadRef.current.get(threadId);
  if (existing) {
    return existing;
  }

  const created = new Set<string>();
  seenEventIdsByThreadRef.current.set(threadId, created);
  return created;
}

function updateLastEventIdx(
  lastEventIdxByThreadRef: MutableRefObject<Map<string, number>>,
  threadId: string,
  idx: number,
) {
  const current = lastEventIdxByThreadRef.current.get(threadId);
  if (current == null || idx > current) {
    lastEventIdxByThreadRef.current.set(threadId, idx);
  }
}

function seedThreadEventCache(params: {
  snapshot: ChatThreadSnapshot | null | undefined;
  threadId: string;
  seenEventIdsByThreadRef: MutableRefObject<Map<string, Set<string>>>;
  lastEventIdxByThreadRef: MutableRefObject<Map<string, number>>;
}) {
  const { snapshot, threadId, seenEventIdsByThreadRef, lastEventIdxByThreadRef } = params;
  const cachedEvents = snapshot?.events;
  if (!cachedEvents || cachedEvents.length === 0) {
    return;
  }

  const seenEventIds = ensureSeenEventIds(seenEventIdsByThreadRef, threadId);
  for (const event of cachedEvents) {
    seenEventIds.add(event.id);
    updateLastEventIdx(lastEventIdxByThreadRef, threadId, event.idx);
  }
}


function patchThreadListCache(params: {
  queryClient: ReturnType<typeof useQueryClient>;
  worktreeId: string;
  threadId: string;
  active?: boolean;
  threadTitle?: string | null;
}) {
  const { queryClient, worktreeId, threadId, active, threadTitle } = params;

  queryClient.setQueryData<ChatThread[] | undefined>(queryKeys.threads.list(worktreeId), (current) => {
    if (!current) {
      return current;
    }

    let next = current;

    if (threadTitle) {
      next = applyThreadTitleUpdate(next, threadId, threadTitle);
    }

    if (typeof active !== "boolean") {
      return next;
    }

    const index = next.findIndex((thread) => thread.id === threadId);
    if (index === -1 || next[index]?.active === active) {
      return next;
    }

    const updated = [...next];
    updated[index] = { ...updated[index]!, active };
    return updated;
  });
}

function stopThreadStream(streamsRef: MutableRefObject<Map<string, ThreadStreamState>>, threadId: string) {
  const state = streamsRef.current.get(threadId);
  if (!state) {
    return;
  }

  state.stopped = true;
  if (state.reconnectTimer !== null) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.stream.close();
  streamsRef.current.delete(threadId);
}

export function useBackgroundWorktreeStatusStream(
  repositories: Repository[],
  selectedWorktreeId: string | null,
  selectedThreadId: string | null,
) {
  const queryClient = useQueryClient();
  const streamsRef = useRef<Map<string, ThreadStreamState>>(new Map());
  const seenEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const lastEventIdxByThreadRef = useRef<Map<string, number>>(new Map());
  const recentlyRelevantThreadIdsRef = useRef<Set<string>>(new Set());

  const activeWorktreeIds = useMemo(
    () => repositories
      .flatMap((repository) => repository.worktrees.filter((worktree) => worktree.status === "active").map((worktree) => worktree.id))
      .filter((worktreeId) => worktreeId !== selectedWorktreeId),
    [repositories, selectedWorktreeId],
  );

  const repositoryIdByWorktreeId = useMemo(() => {
    const map = new Map<string, string>();
    for (const repository of repositories) {
      for (const worktree of repository.worktrees) {
        map.set(worktree.id, repository.id);
      }
    }
    return map;
  }, [repositories]);

  const threadListQueries = useQueries({
    queries: activeWorktreeIds.map((worktreeId) => ({
      queryKey: queryKeys.threads.list(worktreeId),
      queryFn: () => api.listThreads(worktreeId),
      enabled: worktreeId.length > 0,
      staleTime: 5_000,
    })),
  });

  const threadEntries = useMemo(
    () => activeWorktreeIds.flatMap((worktreeId, index) =>
      (threadListQueries[index]?.data ?? []).map((thread) => ({ thread, worktreeId }))),
    [activeWorktreeIds, threadListQueries],
  );

  const subscribedThreads = useMemo(
    () => threadEntries.filter(({ thread }) => thread.active && thread.id !== selectedThreadId),
    [selectedThreadId, threadEntries],
  );

  useEffect(() => {
    const desiredThreadIds = new Set(subscribedThreads.map(({ thread }) => thread.id));

    for (const threadId of streamsRef.current.keys()) {
      if (!desiredThreadIds.has(threadId)) {
        stopThreadStream(streamsRef, threadId);
      }
    }

    for (const { thread, worktreeId } of subscribedThreads) {
      if (streamsRef.current.has(thread.id)) {
        continue;
      }

      seedThreadEventCache({
        snapshot: queryClient.getQueryData<ChatThreadSnapshot>(queryKeys.threads.statusSnapshot(thread.id)) ?? null,
        threadId: thread.id,
        seenEventIdsByThreadRef,
        lastEventIdxByThreadRef,
      });

      const startStream = (reconnectAttempts = 0) => {
        const streamUrl = new URL(`${api.runtimeBaseUrl}/api/threads/${thread.id}/events/stream`);
        const lastEventIdx = lastEventIdxByThreadRef.current.get(thread.id);
        if (typeof lastEventIdx === "number") {
          streamUrl.searchParams.set("afterIdx", String(lastEventIdx));
        }

        const stream = new EventSource(streamUrl.toString());
        const state: ThreadStreamState = {
          stream,
          reconnectTimer: null,
          reconnectAttempts,
          stopped: false,
          stopRetrying: false,
        };
        streamsRef.current.set(thread.id, state);

        const closeCurrentStream = () => {
          for (const eventType of EVENT_TYPES) {
            stream.removeEventListener(eventType, onEvent as EventListener);
          }
          stream.close();
        };

        const onEvent = (rawEvent: MessageEvent<string>) => {
          const currentState = streamsRef.current.get(thread.id);
          if (!currentState || currentState.stopped) {
            return;
          }

          const payload = JSON.parse(rawEvent.data) as ChatEvent;
          const seenEventIds = ensureSeenEventIds(seenEventIdsByThreadRef, thread.id);
          if (seenEventIds.has(payload.id)) {
            return;
          }

          seenEventIds.add(payload.id);
          updateLastEventIdx(lastEventIdxByThreadRef, thread.id, payload.idx);
          recentlyRelevantThreadIdsRef.current.add(thread.id);

          const nextTitle = payload.type === "chat.completed"
            ? payloadStringOrNull(payload.payload.threadTitle)
            : payload.type === "tool.finished" && payloadStringOrNull(payload.payload.source) === "chat.thread.metadata"
              ? payloadStringOrNull(payload.payload.threadTitle)
              : null;

          if (LIVE_ACTIVITY_EVENT_TYPES.has(payload.type)) {
            patchThreadListCache({
              queryClient,
              worktreeId,
              threadId: thread.id,
              active: true,
              threadTitle: nextTitle,
            });
          } else if (nextTitle) {
            patchThreadListCache({
              queryClient,
              worktreeId,
              threadId: thread.id,
              threadTitle: nextTitle,
            });
          }

          if (GIT_STATUS_INVALIDATION_EVENT_TYPES.has(payload.type)) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitStatus(worktreeId) });
          }

          if (TERMINAL_EVENT_TYPES.has(payload.type)) {
            patchThreadListCache({
              queryClient,
              worktreeId,
              threadId: thread.id,
              active: false,
              threadTitle: nextTitle,
            });
            if (thread.kind === "review") {
              const repositoryId = repositoryIdByWorktreeId.get(worktreeId);
              if (repositoryId) {
                void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.reviews(repositoryId) });
              }
            }
            recentlyRelevantThreadIdsRef.current.delete(thread.id);
            void queryClient.invalidateQueries({ queryKey: queryKeys.threads.statusSnapshot(thread.id) });
            stopThreadStream(streamsRef, thread.id);
            return;
          }

          if (SNAPSHOT_INVALIDATION_EVENT_TYPES.has(payload.type)) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.threads.statusSnapshot(thread.id) });
          }
        };

        for (const eventType of EVENT_TYPES) {
          stream.addEventListener(eventType, onEvent as EventListener);
        }

        stream.onopen = () => {
          const currentState = streamsRef.current.get(thread.id);
          if (!currentState) {
            return;
          }
          currentState.reconnectAttempts = 0;
        };

        stream.onerror = () => {
          const currentState = streamsRef.current.get(thread.id);
          if (!currentState || currentState.stopped || stream.readyState !== EventSource.CLOSED) {
            return;
          }

          closeCurrentStream();

          if (currentState.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(worktreeId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.threads.statusSnapshot(thread.id) });
            streamsRef.current.delete(thread.id);
            return;
          }

          const nextAttempts = currentState.reconnectAttempts + 1;
          const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, currentState.reconnectAttempts);
          currentState.reconnectTimer = setTimeout(() => {
            const latest = streamsRef.current.get(thread.id);
            if (!latest || latest.stopped) {
              return;
            }
            streamsRef.current.delete(thread.id);
            startStream(nextAttempts);
          }, delay);
        };
      };

      startStream();
    }
  }, [queryClient, repositoryIdByWorktreeId, subscribedThreads]);

  useEffect(() => {
    return () => {
      for (const threadId of [...streamsRef.current.keys()]) {
        stopThreadStream(streamsRef, threadId);
      }
    };
  }, []);
}
