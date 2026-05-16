import type { ChatEvent } from "@codesymphony/shared-types";

export const SNAPSHOT_INVALIDATION_EVENT_TYPES = new Set<ChatEvent["type"]>([
  "tool.started",
  "tool.finished",
  "todo.updated",
  "permission.requested",
  "permission.resolved",
  "question.requested",
  "question.answered",
  "question.dismissed",
  "plan.created",
  "plan.approved",
  "plan.dismissed",
  "plan.revision_requested",
  "subagent.started",
  "subagent.finished",
  "chat.completed",
  "chat.failed",
]);
