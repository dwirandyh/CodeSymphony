import type { ChatEventType as DbChatEventType } from "@prisma/client";
import type {
  ChatEvent,
  ChatEventsPage,
  ChatMessagesPage,
} from "@codesymphony/shared-types";
import { mapChatMessage } from "../mappers.js";

export const DEFAULT_MESSAGES_PAGE_LIMIT = 50;
export const MAX_MESSAGES_PAGE_LIMIT = 200;
export const DEFAULT_EVENTS_PAGE_LIMIT = 400;
export const MAX_EVENTS_PAGE_LIMIT = 2000;
export const SNAPSHOT_EVENT_BUDGET_MAX = 2000;

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
  subagent_started: "subagent.started",
  subagent_finished: "subagent.finished",
  chat_completed: "chat.completed",
  chat_failed: "chat.failed",
};

export function normalizePageLimit(rawLimit: number | undefined, defaults: { fallback: number; max: number }): number {
  if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit)) {
    return defaults.fallback;
  }
  const integer = Math.trunc(rawLimit);
  if (integer <= 0) {
    return defaults.fallback;
  }
  return Math.min(integer, defaults.max);
}

export function buildMessagesPage(rows: Array<Parameters<typeof mapChatMessage>[0]>, limit: number): ChatMessagesPage {
  const hasMoreOlder = rows.length > limit;
  const pageRows = hasMoreOlder ? rows.slice(0, limit) : rows;
  const ordered = pageRows.reverse().map(mapChatMessage);
  const oldestSeq = ordered.length > 0 ? ordered[0].seq : null;
  const newestSeq = ordered.length > 0 ? ordered[ordered.length - 1].seq : null;

  return {
    data: ordered,
    pageInfo: {
      hasMoreOlder,
      nextBeforeSeq: hasMoreOlder ? oldestSeq : null,
      oldestSeq,
      newestSeq,
    },
  };
}

export function buildEventsPage(
  rows: Array<{ id: string; threadId: string; idx: number; type: DbChatEventType; payload: unknown; createdAt: Date }>,
  limit: number,
): ChatEventsPage {
  const hasMoreOlder = rows.length > limit;
  const pageRows = hasMoreOlder ? rows.slice(0, limit) : rows;
  const ordered = pageRows.reverse().map((row) => ({
    id: row.id,
    threadId: row.threadId,
    idx: row.idx,
    type: chatEventTypeFromDb[row.type],
    payload: row.payload as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }));
  const oldestIdx = ordered.length > 0 ? ordered[0].idx : null;
  const newestIdx = ordered.length > 0 ? ordered[ordered.length - 1].idx : null;

  return {
    data: ordered,
    pageInfo: {
      hasMoreOlder,
      nextBeforeIdx: hasMoreOlder ? oldestIdx : null,
      oldestIdx,
      newestIdx,
    },
  };
}

export function eventCarriesTimelineContext(payload: unknown): boolean {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;

  const toolUseId = record.toolUseId;
  if (typeof toolUseId === "string" && toolUseId.length > 0) {
    return true;
  }

  const precedingToolUseIds = record.precedingToolUseIds;
  if (Array.isArray(precedingToolUseIds) && precedingToolUseIds.some((entry) => typeof entry === "string" && entry.length > 0)) {
    return true;
  }

  const messageId = record.messageId;
  return typeof messageId === "string" && messageId.length > 0;
}
