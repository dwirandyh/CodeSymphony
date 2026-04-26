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

export type ThreadSnapshotHydrationMode = "replace" | "merge";

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

function mergeOlderSnapshotEvents(snapshotEvents: ChatEvent[], currentEvents: ChatEvent[]) {
  const merged = new Map(currentEvents.map((event) => [event.id, event]));
  for (const snapshotEvent of snapshotEvents) {
    if (!merged.has(snapshotEvent.id)) {
      merged.set(snapshotEvent.id, snapshotEvent);
    }
  }
  return [...merged.values()].sort((left, right) => left.idx - right.idx);
}

function mergeOlderSnapshotMessages(snapshotMessages: ChatMessage[], currentMessages: ChatMessage[]) {
  const merged = new Map(currentMessages.map((message) => [message.id, message]));
  for (const snapshotMessage of snapshotMessages) {
    if (!merged.has(snapshotMessage.id)) {
      merged.set(snapshotMessage.id, snapshotMessage);
    }
  }
  return [...merged.values()].sort((left, right) => left.seq - right.seq);
}

export function hydrateThreadFromSnapshot(params: {
  threadId: string;
  snapshot: ChatTimelineSnapshot;
  mode?: ThreadSnapshotHydrationMode;
}) {
  const { threadId, snapshot, mode = "merge" } = params;
  const { eventsCollection, messagesCollection } = getThreadCollections(threadId);
  const currentEvents = eventsCollection.toArray as ChatEvent[];
  const currentMessages = messagesCollection.toArray as ChatMessage[];
  const snapshotEvents = cloneSortedIfNeeded(snapshot.events, (left, right) => left.idx - right.idx);
  const snapshotMessages = cloneSortedIfNeeded(snapshot.messages, (left, right) => left.seq - right.seq);
  const localNewestEventIdx = getThreadLastEventIdx(threadId) ?? currentEvents[currentEvents.length - 1]?.idx ?? null;
  const localNewestMessageSeq = getThreadLastMessageSeq(threadId) ?? currentMessages[currentMessages.length - 1]?.seq ?? null;
  const allowEventReplace = mode === "replace" && isSnapshotNotOlder(getSnapshotNewestEventIdx(snapshot), localNewestEventIdx);
  const allowMessageReplace = mode === "replace" && isSnapshotNotOlder(getSnapshotNewestMessageSeq(snapshot), localNewestMessageSeq);
  const nextEvents = allowEventReplace
    ? snapshotEvents
    : mode === "replace"
      ? mergeOlderSnapshotEvents(snapshotEvents, currentEvents)
      : mergeEventsWithCurrent(snapshotEvents, currentEvents);
  const nextMessages = allowMessageReplace
    ? snapshotMessages
    : mode === "replace"
      ? mergeOlderSnapshotMessages(snapshotMessages, currentMessages)
      : mergeThreadMessages(snapshotMessages, currentMessages);

  reconcileCollectionRows({
    collection: eventsCollection,
    currentRows: currentEvents,
    nextRows: nextEvents,
    getKey: (event) => event.id,
    areEqual: areEventsEqual,
    deleteMissing: allowEventReplace,
    treatSameKeyAsEqual: true,
  });

  reconcileCollectionRows({
    collection: messagesCollection,
    currentRows: currentMessages,
    nextRows: nextMessages,
    getKey: (message) => message.id,
    areEqual: areMessagesEqual,
    deleteMissing: allowMessageReplace,
  });

  replaceSeenThreadEventIds(threadId, nextEvents.map((event) => event.id));
  setThreadLastEventIdx(threadId, nextEvents[nextEvents.length - 1]?.idx ?? null);
  setThreadLastMessageSeq(threadId, nextMessages[nextMessages.length - 1]?.seq ?? null);

  return {
    events: nextEvents,
    messages: nextMessages,
    allowEventReplace,
    allowMessageReplace,
  };
}
