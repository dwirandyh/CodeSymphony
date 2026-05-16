import type { ChatEvent, CliAgent } from "@codesymphony/shared-types";
import { isRecord, payloadStringOrNull } from "./eventUtils.js";
import type { TimelineTodoItem, TimelineTodoStatus, TodoListGroup, TodoProgressGroup } from "./types.js";

function normalizeTodoStatus(value: unknown): TimelineTodoStatus | null {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled"
    ? (value as TimelineTodoStatus)
    : null;
}

function normalizeTodoItem(value: unknown): TimelineTodoItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const content = payloadStringOrNull(value.content)?.trim();
  const status = normalizeTodoStatus(value.status);
  if (!content || !status) {
    return null;
  }

  const id = payloadStringOrNull(value.id) ?? null;
  return { id, content, status };
}

function normalizeAgent(value: unknown): CliAgent | null {
  return value === "claude" || value === "codex" || value === "cursor" || value === "opencode"
    ? value
    : null;
}

type TodoSnapshot = {
  eventId: string;
  groupId: string;
  agent: CliAgent;
  explanation: string | null;
  items: TimelineTodoItem[];
  idx: number;
  createdAt: string;
};

function normalizeTodoSnapshot(event: ChatEvent): TodoSnapshot | null {
  if (event.type !== "todo.updated") {
    return null;
  }

  const groupId = payloadStringOrNull(event.payload.groupId)?.trim();
  const agent = normalizeAgent(event.payload.agent);
  if (!groupId || !agent) {
    return null;
  }

  const items = Array.isArray(event.payload.items)
    ? event.payload.items
      .map(normalizeTodoItem)
      .filter((item): item is TimelineTodoItem => item != null)
    : [];
  if (items.length === 0) {
    return null;
  }

  return {
    eventId: event.id,
    groupId,
    agent,
    explanation: payloadStringOrNull(event.payload.explanation)?.trim() ?? null,
    items,
    idx: event.idx,
    createdAt: event.createdAt,
  };
}

function resolveTodoListStatus(items: TimelineTodoItem[]): TodoListGroup["status"] {
  return items.some((item) => item.status === "pending" || item.status === "in_progress")
    ? "running"
    : "completed";
}

function todoGroupKey(agent: CliAgent, groupId: string): string {
  return `${agent}:${groupId}`;
}

function todoProgressKey(item: TimelineTodoItem): string {
  return item.id?.trim() || item.content.trim();
}

export function extractTodoListGroups(events: ChatEvent[]): TodoListGroup[] {
  const groups = new Map<string, TodoListGroup>();

  for (const event of events) {
    const snapshot = normalizeTodoSnapshot(event);
    if (!snapshot) {
      continue;
    }

    const key = todoGroupKey(snapshot.agent, snapshot.groupId);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        id: key,
        groupId: snapshot.groupId,
        agent: snapshot.agent,
        explanation: snapshot.explanation,
        status: resolveTodoListStatus(snapshot.items),
        items: snapshot.items,
        startIdx: snapshot.idx,
        anchorIdx: snapshot.idx,
        createdAt: snapshot.createdAt,
        eventIds: new Set<string>([snapshot.eventId]),
      });
      continue;
    }

    existing.explanation = snapshot.explanation;
    existing.status = resolveTodoListStatus(snapshot.items);
    existing.items = snapshot.items;
    existing.eventIds.add(snapshot.eventId);
  }

  return [...groups.values()].sort((a, b) => a.startIdx - b.startIdx);
}

export function extractTodoProgressGroups(events: ChatEvent[]): TodoProgressGroup[] {
  const progressGroups: TodoProgressGroup[] = [];
  const previousActiveTodoByGroup = new Map<string, string>();

  for (const event of events) {
    const snapshot = normalizeTodoSnapshot(event);
    if (!snapshot) {
      continue;
    }

    const activeTodo = snapshot.items.find((item) => item.status === "in_progress") ?? null;
    if (!activeTodo) {
      continue;
    }

    const groupKey = todoGroupKey(snapshot.agent, snapshot.groupId);
    const activeKey = todoProgressKey(activeTodo);
    if (previousActiveTodoByGroup.get(groupKey) === activeKey) {
      continue;
    }

    previousActiveTodoByGroup.set(groupKey, activeKey);
    progressGroups.push({
      id: `${groupKey}:${snapshot.eventId}`,
      groupId: snapshot.groupId,
      agent: snapshot.agent,
      todoId: activeTodo.id ?? null,
      content: activeTodo.content,
      startIdx: snapshot.idx,
      anchorIdx: snapshot.idx,
      createdAt: snapshot.createdAt,
      eventIds: new Set<string>([snapshot.eventId]),
    });
  }

  return progressGroups.sort((a, b) => a.startIdx - b.startIdx);
}
