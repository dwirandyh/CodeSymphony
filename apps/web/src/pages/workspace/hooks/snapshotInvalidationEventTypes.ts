import type { ChatEvent } from "@codesymphony/shared-types";

export const SNAPSHOT_INVALIDATION_EVENT_TYPES = new Set<ChatEvent["type"]>([
  "permission.requested",
  "permission.resolved",
  "question.requested",
  "question.answered",
  "question.dismissed",
  "plan.created",
  "plan.approved",
  "plan.revision_requested",
  "chat.completed",
  "chat.failed",
]);
