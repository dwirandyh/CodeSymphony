import type { RuntimeDeps } from "../../types.js";
import { recoverPendingPlan } from "./chatPlanService.js";
import type { PendingPlanEntry } from "./chatService.types.js";

type PendingPlanThreadState = {
  id: string;
  pendingPlanEventId: string | null;
  pendingPlanFilePath: string | null;
  pendingPlanContent: string | null;
};

function normalizePendingPlanString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function toPendingPlanEntry(thread: PendingPlanThreadState): PendingPlanEntry | null {
  const eventId = normalizePendingPlanString(thread.pendingPlanEventId);
  const filePath = normalizePendingPlanString(thread.pendingPlanFilePath);
  const content = normalizePendingPlanString(thread.pendingPlanContent);

  if (!eventId || !filePath || !content) {
    return null;
  }

  return {
    eventId,
    filePath,
    content,
  };
}

export function buildPendingPlanUpdate(plan: PendingPlanEntry | null) {
  return {
    pendingPlanEventId: plan?.eventId ?? null,
    pendingPlanFilePath: plan?.filePath ?? null,
    pendingPlanContent: plan?.content ?? null,
  };
}

export async function persistPendingPlan(params: {
  deps: RuntimeDeps;
  threadId: string;
  plan: PendingPlanEntry;
}): Promise<void> {
  await params.deps.prisma.chatThread.update({
    where: { id: params.threadId },
    data: buildPendingPlanUpdate(params.plan),
  });
}

export async function clearPendingPlan(params: {
  deps: RuntimeDeps;
  threadId: string;
}): Promise<void> {
  await params.deps.prisma.chatThread.update({
    where: { id: params.threadId },
    data: buildPendingPlanUpdate(null),
  });
}

export async function loadPendingPlan(params: {
  deps: RuntimeDeps;
  thread: PendingPlanThreadState;
}): Promise<PendingPlanEntry | null> {
  const persisted = toPendingPlanEntry(params.thread);
  if (persisted) {
    return persisted;
  }

  // Compatibility path for threads that still only have event-derived pending plan state.
  const recovered = await recoverPendingPlan(params.deps.eventHub, params.thread.id);
  if (!recovered) {
    return null;
  }

  await persistPendingPlan({
    deps: params.deps,
    threadId: params.thread.id,
    plan: recovered,
  });
  return recovered;
}
