import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import type { PendingMessageMutation } from "./useChatSession.types";

function keysMatchAtSameIndex<T>(
  prefix: T[],
  superset: T[],
  getKey: (row: T) => string,
  areComparable?: (left: T, right: T) => boolean,
): boolean {
  if (prefix.length > superset.length) {
    return false;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    const left = prefix[index];
    const right = superset[index];
    if (getKey(left) !== getKey(right)) {
      return false;
    }
    if (areComparable && !areComparable(left, right)) {
      return false;
    }
  }

  return true;
}

export function computeAssistantDeltaSuffix(existingContent: string, incomingDelta: string): string {
  if (incomingDelta.length === 0) {
    return "";
  }

  if (existingContent.length === 0) {
    return incomingDelta;
  }

  if (existingContent.endsWith(incomingDelta)) {
    return "";
  }

  if (incomingDelta.startsWith(existingContent)) {
    return incomingDelta.slice(existingContent.length);
  }

  const maxOverlap = Math.min(existingContent.length, incomingDelta.length);
  for (let overlapLength = maxOverlap; overlapLength > 0; overlapLength -= 1) {
    if (existingContent.endsWith(incomingDelta.slice(0, overlapLength))) {
      return incomingDelta.slice(overlapLength);
    }
  }

  return incomingDelta;
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

export function insertAllEvents(current: ChatEvent[], incoming: ChatEvent[]): ChatEvent[] {
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

export function applyMessageMutations(
  current: ChatMessage[],
  mutations: PendingMessageMutation[],
): ChatMessage[] {
  if (mutations.length === 0) return current;
  const knownIds = new Set<string>();
  const contentById = new Map<string, string>();
  for (const m of current) knownIds.add(m.id);
  for (const m of current) contentById.set(m.id, m.content);
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
        contentById.set(mut.id, "");
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
        contentById.set(mut.id, mut.delta);
      } else if (mut.role !== "user" && mut.delta.length > 0) {
        const effectiveContent = contentById.get(mut.id) ?? "";
        const suffix = computeAssistantDeltaSuffix(effectiveContent, mut.delta);
        if (suffix.length === 0) {
          continue;
        }
        const pendingContent = appendedDeltas.get(mut.id) ?? "";
        appendedDeltas.set(mut.id, pendingContent + suffix);
        contentById.set(mut.id, effectiveContent + suffix);
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

export function prunePendingStreamUpdatesForSnapshot(params: {
  pendingEvents: ChatEvent[];
  pendingMutations: PendingMessageMutation[];
  snapshotNewestIdx: number | null;
}): {
  pendingEvents: ChatEvent[];
  pendingMutations: PendingMessageMutation[];
} {
  const { pendingEvents, pendingMutations, snapshotNewestIdx } = params;
  if (snapshotNewestIdx == null) {
    return { pendingEvents, pendingMutations };
  }

  const nextPendingEvents = pendingEvents.filter((event) => event.idx > snapshotNewestIdx);
  const nextPendingMutations = pendingMutations.filter((mutation) => (
    mutation.kind !== "message-delta"
    || mutation.eventIdx == null
    || mutation.eventIdx > snapshotNewestIdx
  ));

  return {
    pendingEvents: nextPendingEvents,
    pendingMutations: nextPendingMutations,
  };
}

export function mergeEventsWithCurrent(queriedEvents: ChatEvent[], current: ChatEvent[]): ChatEvent[] {
  if (queriedEvents.length === 0) {
    return current;
  }

  if (current.length === 0) {
    return queriedEvents;
  }

  if (keysMatchAtSameIndex(
    current,
    queriedEvents,
    (event) => event.id,
    (left, right) => left.idx === right.idx,
  )) {
    return queriedEvents.length === current.length ? current : queriedEvents;
  }

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
