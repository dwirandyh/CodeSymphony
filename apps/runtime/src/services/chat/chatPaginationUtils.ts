import type { ChatEventType as DbChatEventType } from "@prisma/client";
import type { ChatEvent, ChatMessage, ChatTimelineItem } from "@codesymphony/shared-types";
import { mapChatMessage } from "../mappers.js";
import { buildTimelineFromSeed } from "./chatTimelineAssembler.js";

export const DISPLAY_TIMELINE_TAIL_MESSAGE_LIMIT = 64;
export const DISPLAY_TIMELINE_TAIL_EVENT_LIMIT = 400;

const chatEventTypeFromDb: Partial<Record<DbChatEventType, ChatEvent["type"]>> = {
  message_delta: "message.delta",
  tool_started: "tool.started",
  tool_output: "tool.output",
  tool_finished: "tool.finished",
  permission_requested: "permission.requested",
  permission_resolved: "permission.resolved",
  question_requested: "question.requested",
  question_answered: "question.answered",
  question_dismissed: "question.dismissed",
  plan_created: "plan.created",
  plan_approved: "plan.approved",
  plan_dismissed: "plan.dismissed",
  plan_revision_requested: "plan.revision_requested",
  subagent_started: "subagent.started",
  subagent_finished: "subagent.finished",
  chat_completed: "chat.completed",
  chat_failed: "chat.failed",
};

export function mapMessages(rows: Array<Parameters<typeof mapChatMessage>[0]>) {
  return rows.map(mapChatMessage);
}

export function mapEvents(
  rows: Array<{ id: string; threadId: string; idx: number; type: DbChatEventType; payload: unknown; createdAt: Date }>,
): ChatEvent[] {
  return rows.flatMap((row) => {
    const type = chatEventTypeFromDb[row.type];
    if (!type) {
      return [];
    }

    return [{
      id: row.id,
      threadId: row.threadId,
      idx: row.idx,
      type,
      payload: row.payload as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
    }];
  });
}

export function selectNewestRowsAscending<T>(rowsDescending: T[], limit: number): {
  rows: T[];
  olderRowsAvailable: boolean;
} {
  const newestRowsDescending = rowsDescending.slice(0, limit);

  return {
    rows: newestRowsDescending.reverse(),
    olderRowsAvailable: rowsDescending.length > limit,
  };
}

function getPayloadMessageId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload == null || Array.isArray(payload)) {
    return null;
  }

  const messageId = (payload as Record<string, unknown>).messageId;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : null;
}

export function trimMessagesToEventWindow(
  messages: ChatMessage[],
  events: ChatEvent[],
): ChatMessage[] {
  if (messages.length <= 1 || events.length === 0) {
    return messages;
  }

  const messageSeqById = new Map(messages.map((message) => [message.id, message.seq]));
  let earliestCoveredSeq: number | null = null;

  for (const event of events) {
    const messageId = getPayloadMessageId(event.payload);
    if (!messageId) {
      continue;
    }

    const seq = messageSeqById.get(messageId);
    if (seq == null) {
      continue;
    }

    if (earliestCoveredSeq == null || seq < earliestCoveredSeq) {
      earliestCoveredSeq = seq;
    }
  }

  if (earliestCoveredSeq == null) {
    return messages;
  }

  const trimmedMessages = messages.filter((message) => message.seq >= earliestCoveredSeq);
  return trimmedMessages.length > 0 ? trimmedMessages : messages;
}

export function buildTimelineSnapshot(params: {
  messages: ReturnType<typeof mapChatMessage>[];
  events: ChatEvent[];
  threadId: string | null;
  includeCollections?: boolean;
  olderHistoryAvailable?: boolean;
}) {
  const {
    messages,
    events,
    threadId,
    includeCollections = true,
    olderHistoryAvailable = false,
  } = params;

  const assembly = buildTimelineFromSeed({
    messages,
    events,
    selectedThreadId: threadId,
    semanticHydrationInProgress: false,
  });

  const newestSeq = messages.length > 0 ? messages[messages.length - 1].seq : null;
  const newestIdx = events.length > 0 ? events[events.length - 1].idx : null;

  const timelineItems = assembly.items.map((item): ChatTimelineItem => {
    if (item.kind !== "message" || item.context == null) {
      return item;
    }

    const { context: _context, ...rest } = item;
    return rest;
  });

  return {
    timelineItems,
    summary: {
      ...assembly.summary,
      oldestRenderableHydrationPending:
        assembly.summary.oldestRenderableHydrationPending || olderHistoryAvailable,
    },
    newestSeq,
    newestIdx,
    collectionsIncluded: includeCollections,
    messages: includeCollections ? messages : [],
    events: includeCollections ? events : [],
  };
}
