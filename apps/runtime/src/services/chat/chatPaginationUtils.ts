import type { ChatEventType as DbChatEventType } from "@prisma/client";
import type { ChatEvent } from "@codesymphony/shared-types";
import { mapChatMessage } from "../mappers.js";
import { buildTimelineFromSeed } from "./chatTimelineAssembler.js";

export const chatEventTypeFromDb: Record<DbChatEventType, ChatEvent["type"]> = {
  message_delta: "message.delta",
  thinking_delta: "thinking.delta",
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
  plan_revision_requested: "plan.revision_requested",
  commands_updated: "commands.updated",
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
  return rows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    idx: row.idx,
    type: chatEventTypeFromDb[row.type],
    payload: row.payload as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }));
}

export function buildTimelineSnapshot(params: {
  messages: ReturnType<typeof mapChatMessage>[];
  events: ChatEvent[];
  threadId: string | null;
}) {
  const { messages, events, threadId } = params;

  const assembly = buildTimelineFromSeed({
    messages,
    events,
    selectedThreadId: threadId,
    semanticHydrationInProgress: false,
  });

  const newestSeq = messages.length > 0 ? messages[messages.length - 1].seq : null;
  const newestIdx = events.length > 0 ? events[events.length - 1].idx : null;

  return {
    timelineItems: assembly.items,
    summary: assembly.summary,
    newestSeq,
    newestIdx,
    messages,
    events,
  };
}
