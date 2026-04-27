import type {
  ChatEvent,
  ChatMessage,
  ChatTimelineSnapshot,
} from "@codesymphony/shared-types";
import {
  getThreadCollections,
} from "./threadCollections";
import {
  getThreadLastEventIdx,
  getThreadLastMessageSeq,
  replaceSeenThreadEventIds,
  setThreadLastEventIdx,
  setThreadLastMessageSeq,
} from "./threadStreamState";
import { mergeEventsWithCurrent } from "../pages/workspace/hooks/chat-session/messageEventMerge";
import { areMessagesEqual, mergeThreadMessages } from "../pages/workspace/hooks/messageMerge";

export type ThreadSnapshotHydrationMode = "replace" | "merge" | "prepend";

type HydrationTiming = {
  totalDurationMs: number;
  readCollectionsMs: number;
  sortSnapshotMs: number;
  mergeRowsMs: number;
  writeCollectionsMs: number;
  streamStateMs: number;
};

type MergeOlderRowsResult<T> = {
  rows: T[];
  insertRows: T[];
};

function getPerfNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
}

function roundPerfMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function areEventPayloadsEqual(left: ChatEvent["payload"], right: ChatEvent["payload"]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function areEventsEqual(left: ChatEvent, right: ChatEvent) {
  return (
    left.id === right.id
    && left.threadId === right.threadId
    && left.idx === right.idx
    && left.type === right.type
    && left.createdAt === right.createdAt
    && areEventPayloadsEqual(left.payload, right.payload)
  );
}

function isSnapshotNotOlder(snapshotNewest: number | null, localNewest: number | null) {
  return localNewest == null || snapshotNewest == null || snapshotNewest >= localNewest;
}

function cloneSortedIfNeeded<T>(rows: T[], compare: (left: T, right: T) => number): T[] {
  for (let index = 1; index < rows.length; index += 1) {
    if (compare(rows[index - 1], rows[index]) > 0) {
      return [...rows].sort(compare);
    }
  }

  return rows;
}

function rowsAlignAsPrefix<T>(
  currentRows: T[],
  nextRows: T[],
  getKey: (row: T) => string,
): boolean {
  if (currentRows.length > nextRows.length) {
    return false;
  }

  for (let index = 0; index < currentRows.length; index += 1) {
    if (getKey(currentRows[index]) !== getKey(nextRows[index])) {
      return false;
    }
  }

  return true;
}

function reconcileCollectionRows<T extends object>(params: {
  collection: {
    delete: (keys: string[] | string) => unknown;
    update: (key: string, callback: (draft: T) => void) => unknown;
    insert: (rows: T[] | T) => unknown;
  };
  currentRows: T[];
  nextRows: T[];
  getKey: (row: T) => string;
  areEqual: (left: T, right: T) => boolean;
  deleteMissing: boolean;
  treatSameKeyAsEqual?: boolean;
}) {
  const {
    collection,
    currentRows,
    nextRows,
    getKey,
    areEqual,
    deleteMissing,
    treatSameKeyAsEqual = false,
  } = params;

  if (
    !deleteMissing
    && currentRows.length < nextRows.length
    && rowsAlignAsPrefix(currentRows, nextRows, getKey)
    && treatSameKeyAsEqual
  ) {
    collection.insert(nextRows.slice(currentRows.length));
    return;
  }

  if (
    !deleteMissing
    && currentRows.length > 0
    && nextRows.length > currentRows.length
    && !rowsAlignAsPrefix(currentRows, nextRows, getKey)
  ) {
    collection.delete(currentRows.map((row) => getKey(row)));
    collection.insert(nextRows);
    return;
  }

  const currentByKey = new Map(currentRows.map((row) => [getKey(row), row]));
  const nextByKey = new Map(nextRows.map((row) => [getKey(row), row]));
  const insertRows: T[] = [];
  const updateRows: T[] = [];
  const deleteKeys: string[] = [];

  for (const row of nextRows) {
    const key = getKey(row);
    const current = currentByKey.get(key);
    if (!current) {
      insertRows.push(row);
      continue;
    }

    if (!treatSameKeyAsEqual && !areEqual(current, row)) {
      updateRows.push(row);
    }
  }

  if (deleteMissing) {
    for (const row of currentRows) {
      const key = getKey(row);
      if (!nextByKey.has(key)) {
        deleteKeys.push(key);
      }
    }
  }

  if (deleteKeys.length > 0) {
    collection.delete(deleteKeys);
  }

  for (const row of updateRows) {
    const key = getKey(row);
    collection.update(key, (draft) => {
      Object.assign(draft, row);
    });
  }

  if (insertRows.length > 0) {
    collection.insert(insertRows);
  }
}

function getSnapshotNewestEventIdx(snapshot: ChatTimelineSnapshot) {
  return snapshot.newestIdx ?? snapshot.events[snapshot.events.length - 1]?.idx ?? null;
}

function getSnapshotNewestMessageSeq(snapshot: ChatTimelineSnapshot) {
  return snapshot.newestSeq ?? snapshot.messages[snapshot.messages.length - 1]?.seq ?? null;
}

function mergeOlderSnapshotRows<T>(
  snapshotRows: T[],
  currentRows: T[],
  params: {
    getKey: (row: T) => string;
    compare: (left: T, right: T) => number;
  },
): MergeOlderRowsResult<T> {
  if (snapshotRows.length === 0) {
    return { rows: currentRows, insertRows: [] };
  }

  if (currentRows.length === 0) {
    return { rows: snapshotRows, insertRows: snapshotRows };
  }

  const currentKeys = new Set(currentRows.map((row) => params.getKey(row)));
  const insertRows = snapshotRows.filter((row) => !currentKeys.has(params.getKey(row)));
  if (insertRows.length === 0) {
    return { rows: currentRows, insertRows };
  }

  const snapshotInterleavesCurrent =
    params.compare(snapshotRows[snapshotRows.length - 1], currentRows[0]) > 0;
  if (!snapshotInterleavesCurrent) {
    return { rows: [...insertRows, ...currentRows], insertRows };
  }

  const merged = new Map(currentRows.map((row) => [params.getKey(row), row]));
  for (const snapshotRow of snapshotRows) {
    const key = params.getKey(snapshotRow);
    if (!merged.has(key)) {
      merged.set(key, snapshotRow);
    }
  }

  return {
    rows: [...merged.values()].sort(params.compare),
    insertRows,
  };
}

function mergeOlderSnapshotEvents(snapshotEvents: ChatEvent[], currentEvents: ChatEvent[]) {
  return mergeOlderSnapshotRows(snapshotEvents, currentEvents, {
    getKey: (event) => event.id,
    compare: (left, right) => left.idx - right.idx,
  });
}

function mergeOlderSnapshotMessages(snapshotMessages: ChatMessage[], currentMessages: ChatMessage[]) {
  return mergeOlderSnapshotRows(snapshotMessages, currentMessages, {
    getKey: (message) => message.id,
    compare: (left, right) => left.seq - right.seq,
  });
}

export function hydrateThreadFromSnapshot(params: {
  threadId: string;
  snapshot: ChatTimelineSnapshot;
  mode?: ThreadSnapshotHydrationMode;
}) {
  const startedAtMs = getPerfNow();
  const { threadId, snapshot, mode = "merge" } = params;
  const { eventsCollection, messagesCollection } = getThreadCollections(threadId);
  const currentEvents = cloneSortedIfNeeded(eventsCollection.toArray as ChatEvent[], (left, right) => left.idx - right.idx);
  const currentMessages = cloneSortedIfNeeded(messagesCollection.toArray as ChatMessage[], (left, right) => left.seq - right.seq);
  const readCollectionsCompletedAtMs = getPerfNow();
  const snapshotEvents = cloneSortedIfNeeded(snapshot.events, (left, right) => left.idx - right.idx);
  const snapshotMessages = cloneSortedIfNeeded(snapshot.messages, (left, right) => left.seq - right.seq);
  const sortSnapshotCompletedAtMs = getPerfNow();
  const localNewestEventIdx = getThreadLastEventIdx(threadId) ?? currentEvents[currentEvents.length - 1]?.idx ?? null;
  const localNewestMessageSeq = getThreadLastMessageSeq(threadId) ?? currentMessages[currentMessages.length - 1]?.seq ?? null;
  const allowEventReplace = mode === "replace" && isSnapshotNotOlder(getSnapshotNewestEventIdx(snapshot), localNewestEventIdx);
  const allowMessageReplace = mode === "replace" && isSnapshotNotOlder(getSnapshotNewestMessageSeq(snapshot), localNewestMessageSeq);
  const olderEventsMerge = mode === "prepend"
    ? mergeOlderSnapshotEvents(snapshotEvents, currentEvents)
    : null;
  const olderMessagesMerge = mode === "prepend"
    ? mergeOlderSnapshotMessages(snapshotMessages, currentMessages)
    : null;
  const nextEvents = mode === "prepend"
    ? olderEventsMerge!.rows
    : allowEventReplace
      ? snapshotEvents
      : mode === "replace"
        ? mergeOlderSnapshotEvents(snapshotEvents, currentEvents).rows
        : mergeEventsWithCurrent(snapshotEvents, currentEvents);
  const nextMessages = mode === "prepend"
    ? olderMessagesMerge!.rows
    : allowMessageReplace
      ? snapshotMessages
      : mode === "replace"
        ? mergeOlderSnapshotMessages(snapshotMessages, currentMessages).rows
        : mergeThreadMessages(snapshotMessages, currentMessages);
  const mergeRowsCompletedAtMs = getPerfNow();

  if (mode === "prepend") {
    if (olderEventsMerge!.insertRows.length > 0) {
      eventsCollection.insert(olderEventsMerge!.insertRows);
    }
    if (olderMessagesMerge!.insertRows.length > 0) {
      messagesCollection.insert(olderMessagesMerge!.insertRows);
    }
  } else {
    reconcileCollectionRows({
      collection: eventsCollection,
      currentRows: currentEvents,
      nextRows: nextEvents,
      getKey: (event) => event.id,
      areEqual: areEventsEqual,
      deleteMissing: mode === "replace" && allowEventReplace,
      treatSameKeyAsEqual: true,
    });

    reconcileCollectionRows({
      collection: messagesCollection,
      currentRows: currentMessages,
      nextRows: nextMessages,
      getKey: (message) => message.id,
      areEqual: areMessagesEqual,
      deleteMissing: mode === "replace" && allowMessageReplace,
    });
  }
  const writeCollectionsCompletedAtMs = getPerfNow();

  replaceSeenThreadEventIds(threadId, nextEvents.map((event) => event.id));
  setThreadLastEventIdx(threadId, nextEvents[nextEvents.length - 1]?.idx ?? null);
  setThreadLastMessageSeq(threadId, nextMessages[nextMessages.length - 1]?.seq ?? null);
  const streamStateCompletedAtMs = getPerfNow();

  return {
    events: nextEvents,
    messages: nextMessages,
    allowEventReplace,
    allowMessageReplace,
    insertedEventCount: mode === "prepend" ? olderEventsMerge!.insertRows.length : 0,
    insertedMessageCount: mode === "prepend" ? olderMessagesMerge!.insertRows.length : 0,
    timing: {
      totalDurationMs: roundPerfMs(streamStateCompletedAtMs - startedAtMs),
      readCollectionsMs: roundPerfMs(readCollectionsCompletedAtMs - startedAtMs),
      sortSnapshotMs: roundPerfMs(sortSnapshotCompletedAtMs - readCollectionsCompletedAtMs),
      mergeRowsMs: roundPerfMs(mergeRowsCompletedAtMs - sortSnapshotCompletedAtMs),
      writeCollectionsMs: roundPerfMs(writeCollectionsCompletedAtMs - mergeRowsCompletedAtMs),
      streamStateMs: roundPerfMs(streamStateCompletedAtMs - writeCollectionsCompletedAtMs),
    } satisfies HydrationTiming,
  };
}
