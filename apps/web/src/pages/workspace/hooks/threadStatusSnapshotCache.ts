import type {
  ChatEvent,
  ChatThreadStatus,
  ChatThreadStatusSnapshot,
} from "@codesymphony/shared-types";

function nextStatusFromEvent(
  previousStatus: ChatThreadStatus | null,
  event: ChatEvent,
): ChatThreadStatus {
  switch (event.type) {
    case "permission.requested":
    case "question.requested":
      return "waiting_approval";
    case "plan.created":
      return "review_plan";
    case "chat.completed":
    case "chat.failed":
    case "plan.dismissed":
      return "idle";
    case "permission.resolved":
    case "question.answered":
    case "question.dismissed":
    case "plan.approved":
    case "plan.revision_requested":
    case "tool.started":
    case "tool.output":
    case "tool.finished":
    case "subagent.started":
    case "subagent.finished":
      return "running";
    default:
      return previousStatus ?? "idle";
  }
}

export function reduceStatusSnapshotWithEvent(
  previous: ChatThreadStatusSnapshot | null | undefined,
  event: ChatEvent,
): ChatThreadStatusSnapshot {
  return {
    status: nextStatusFromEvent(previous?.status ?? null, event),
    newestIdx: Math.max(previous?.newestIdx ?? -1, event.idx),
  };
}
