import type { ChatEventType as DbChatEventType } from "@prisma/client";
import type { ChatEvent, ChatTimelineItem } from "@codesymphony/shared-types";
import { mapChatMessage } from "../mappers.js";
import { buildTimelineFromSeed } from "./chatTimelineAssembler.js";

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

export function buildTimelineSnapshot(params: {
  messages: ReturnType<typeof mapChatMessage>[];
  events: ChatEvent[];
  threadId: string | null;
}) {
  const {
    messages,
    events,
    threadId,
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
      oldestRenderableHydrationPending: false,
    },
    newestSeq,
    newestIdx,
    collectionsIncluded: true,
    messages,
    events,
  };
}
