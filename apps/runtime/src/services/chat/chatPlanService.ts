import type { RuntimeEventHub } from "../../types.js";
import type { PendingPlanEntry } from "./chatService.types.js";

export async function recoverPendingPlan(
  eventHub: RuntimeEventHub,
  threadId: string,
): Promise<PendingPlanEntry | null> {
  const events = await eventHub.list(threadId);
  let lastPlan: PendingPlanEntry | null = null;

  for (const event of events) {
    if (event.type === "plan.created") {
      const content = typeof event.payload.content === "string" ? event.payload.content : "";
      const filePath = typeof event.payload.filePath === "string" ? event.payload.filePath : "";
      if (content.length > 0) {
        lastPlan = { content, filePath };
      }
    } else if (event.type === "plan.approved" || event.type === "plan.revision_requested") {
      lastPlan = null;
    }
  }

  return lastPlan;
}
