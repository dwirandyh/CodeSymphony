import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type {
  ChatEvent,
  ChatMessage,
  ChatThread,
  ChatThreadSnapshot,
} from "@codesymphony/shared-types";
import type { SnapshotSeedMode, ThreadMetadataSnapshot } from "./useChatSession.types";
import { mergeEventsWithCurrent } from "./messageEventMerge";
import { areMessageArraysEqual, mergeThreadMessages } from "../messageMerge";
import { payloadStringOrNull } from "../../eventUtils";

export function applySnapshotSeed(params: {
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
  mode?: SnapshotSeedMode;
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
    mode = "merge",
  } = params;

  const queriedMessages = snapshot.messages.data;
  const queriedEvents = snapshot.events.data;
  const localLatestEventIdx = lastEventIdxByThreadRef.current.get(selectedThreadId) ?? null;
  const snapshotNewestIdx = snapshot.watermarks.newestIdx ?? null;
  const activeThreadSnapshotIsNotOlder =
    activeThreadIdRef.current !== selectedThreadId
    || localLatestEventIdx == null
    || snapshotNewestIdx == null
    || snapshotNewestIdx >= localLatestEventIdx;

  if (import.meta.env.DEV) {
    console.debug("[snapshotSeed] apply", {
      selectedThreadId,
      mode,
      queriedMessagesLength: queriedMessages.length,
      queriedEventsLength: queriedEvents.length,
      newestIdx: snapshot.watermarks.newestIdx,
    });
  }

  setMessages((current) => {
    if (mode === "replace") {
      const replacement = [...queriedMessages].sort((a, b) => a.seq - b.seq);
      if (areMessageArraysEqual(replacement, current)) {
        return current;
      }
      return replacement;
    }

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
    if (mode === "replace") {
      const replacement = [...queriedEvents].sort((a, b) => a.idx - b.idx);
      const hasSameLength = replacement.length === current.length;
      const hasSameIds = hasSameLength && replacement.every((event, index) => current[index]?.id === event.id);
      return hasSameIds ? current : replacement;
    }

    if (current.length === 0) {
      return [...queriedEvents].sort((a, b) => a.idx - b.idx);
    }
    return mergeEventsWithCurrent(queriedEvents, current);
  });

  if (activeThreadSnapshotIsNotOlder) {
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
  }

  const latestMetadata = extractLatestThreadMetadata(queriedEvents);
  if (latestMetadata.threadTitle) {
    setThreads((current) => applyThreadTitleUpdate(current, selectedThreadId, latestMetadata.threadTitle));
  }

  if (latestMetadata.worktreeBranch && selectedWorktreeId) {
    onBranchRenamed?.(selectedWorktreeId, latestMetadata.worktreeBranch);
  }
}

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
