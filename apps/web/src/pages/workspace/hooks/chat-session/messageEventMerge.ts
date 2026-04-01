import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import type { PendingMessageMutation } from "./useChatSession.types";

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
      } else if (mut.role !== "user" && mut.delta.length > 0) {
        const existingContent = current.find((message) => message.id === mut.id)?.content ?? "";
        const pendingContent = appendedDeltas.get(mut.id) ?? "";
        const effectiveContent = existingContent + pendingContent;
        if (effectiveContent.length > 0) {
          if (effectiveContent.endsWith(mut.delta)) {
            continue;
          }
          if (mut.delta.includes(effectiveContent)) {
            appendedDeltas.set(mut.id, mut.delta.slice(effectiveContent.length));
            continue;
          }
        }
        appendedDeltas.set(mut.id, pendingContent + mut.delta);
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
