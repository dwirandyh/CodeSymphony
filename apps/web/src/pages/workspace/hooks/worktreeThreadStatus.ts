import type { ChatEvent, ChatThread, ChatThreadSnapshot } from "@codesymphony/shared-types";
import type { PendingPermissionRequest, PendingPlan, PendingQuestionRequest, QuestionItem } from "../types";
import { shortenReadTargetForDisplay } from "../exploreUtils";
import { isMetadataToolEvent, normalizePlanCreatedEvent } from "../eventUtils";

export type WorktreeThreadUiStatus = "waiting_approval" | "review_plan" | "running" | "idle";

export type WorktreeStatusSummary = {
  kind: WorktreeThreadUiStatus;
  threadId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEditTool(toolName: string): boolean {
  return /^(edit|multiedit|write)$/i.test(toolName.trim());
}

function extractEditTarget(toolName: string, toolInput: unknown): string | null {
  if (!isEditTool(toolName) || !isRecord(toolInput)) {
    return null;
  }

  const keyCandidates = ["file_path", "path", "file", "filepath", "target", "filename"];
  for (const key of keyCandidates) {
    const raw = toolInput[key];
    if (typeof raw !== "string") {
      continue;
    }
    const normalized = raw.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return null;
}

function toOrderedEvents(events: ChatEvent[]): ChatEvent[] {
  return [...events].sort((a, b) => a.idx - b.idx);
}

export function hasRunningAssistantActivity(events: ChatEvent[]): boolean {
  const orderedEvents = toOrderedEvents(events);
  const activeToolUseIds = new Set<string>();
  const activeSubagentToolUseIds = new Set<string>();
  let sawAssistantActivitySinceTerminalEvent = false;

  for (const event of orderedEvents) {
    if (event.type === "chat.completed" || event.type === "chat.failed") {
      activeToolUseIds.clear();
      activeSubagentToolUseIds.clear();
      sawAssistantActivitySinceTerminalEvent = false;
      continue;
    }

    if (event.type === "tool.started") {
      const toolUseId = typeof event.payload.toolUseId === "string" ? event.payload.toolUseId : "";
      if (toolUseId.length > 0) {
        activeToolUseIds.add(toolUseId);
      }
      sawAssistantActivitySinceTerminalEvent = true;
      continue;
    }

    if (event.type === "tool.finished") {
      if (isMetadataToolEvent(event)) {
        continue;
      }

      const toolUseId = typeof event.payload.toolUseId === "string" ? event.payload.toolUseId : "";
      if (toolUseId.length > 0) {
        activeToolUseIds.delete(toolUseId);
      }

      const precedingToolUseIds = Array.isArray(event.payload.precedingToolUseIds)
        ? event.payload.precedingToolUseIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        : [];
      for (const precedingToolUseId of precedingToolUseIds) {
        activeToolUseIds.delete(precedingToolUseId);
      }

      sawAssistantActivitySinceTerminalEvent = true;
      continue;
    }

    if (event.type === "subagent.started") {
      const toolUseId = typeof event.payload.toolUseId === "string" ? event.payload.toolUseId : "";
      if (toolUseId.length > 0) {
        activeSubagentToolUseIds.add(toolUseId);
      }
      sawAssistantActivitySinceTerminalEvent = true;
      continue;
    }

    if (event.type === "subagent.finished") {
      const toolUseId = typeof event.payload.toolUseId === "string" ? event.payload.toolUseId : "";
      if (toolUseId.length > 0) {
        activeSubagentToolUseIds.delete(toolUseId);
      }
      sawAssistantActivitySinceTerminalEvent = true;
      continue;
    }

    if (event.type === "message.delta" && event.payload.role === "assistant") {
      sawAssistantActivitySinceTerminalEvent = true;
      continue;
    }

    if (
      event.type === "tool.output"
      || event.type === "permission.requested"
      || event.type === "question.requested"
      || event.type === "plan.created"
    ) {
      sawAssistantActivitySinceTerminalEvent = true;
    }
  }

  return (
    activeToolUseIds.size > 0
    || activeSubagentToolUseIds.size > 0
    || sawAssistantActivitySinceTerminalEvent
  );
}

export function derivePendingPermissionRequests(events: ChatEvent[]): PendingPermissionRequest[] {
  const pendingPermById = new Map<string, PendingPermissionRequest>();
  const orderedEvents = toOrderedEvents(events);

  for (const event of orderedEvents) {
    if (event.type === "permission.requested") {
      const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
      if (requestId.length === 0) {
        continue;
      }
      const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : "Tool";
      const toolInput = isRecord(event.payload.toolInput) ? event.payload.toolInput : null;
      const editTargetRaw = extractEditTarget(toolName, toolInput);
      const editTarget = editTargetRaw ? shortenReadTargetForDisplay(editTargetRaw) : null;

      pendingPermById.set(requestId, {
        requestId,
        toolName,
        command: typeof event.payload.command === "string" ? event.payload.command : null,
        editTarget,
        blockedPath: typeof event.payload.blockedPath === "string" ? event.payload.blockedPath : null,
        decisionReason: typeof event.payload.decisionReason === "string" ? event.payload.decisionReason : null,
        idx: event.idx,
      });
      continue;
    }

    if (event.type === "permission.resolved") {
      const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
      if (requestId.length > 0) {
        pendingPermById.delete(requestId);
      }
      continue;
    }

    if (event.type === "chat.completed" || event.type === "chat.failed") {
      pendingPermById.clear();
    }
  }

  return Array.from(pendingPermById.values()).sort((a, b) => a.idx - b.idx);
}

export function derivePendingQuestionRequests(events: ChatEvent[]): PendingQuestionRequest[] {
  const pendingQById = new Map<string, PendingQuestionRequest>();
  const orderedEvents = toOrderedEvents(events);

  for (const event of orderedEvents) {
    if (event.type === "question.requested") {
      const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
      if (requestId.length === 0) {
        continue;
      }

      const rawQuestions = Array.isArray(event.payload.questions) ? event.payload.questions : [];
      const questions: QuestionItem[] = rawQuestions.map((q: Record<string, unknown>) => ({
        question: typeof q.question === "string" ? q.question : "",
        header: typeof q.header === "string" ? q.header : undefined,
        options: Array.isArray(q.options)
          ? q.options.map((o: Record<string, unknown>) => ({
            label: typeof o.label === "string" ? o.label : "",
            description: typeof o.description === "string" ? o.description : undefined,
          }))
          : undefined,
        multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : undefined,
      }));

      pendingQById.set(requestId, { requestId, questions, idx: event.idx });
      continue;
    }

    if (event.type === "question.answered" || event.type === "question.dismissed") {
      const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
      if (requestId.length > 0) {
        pendingQById.delete(requestId);
      }
      continue;
    }

    if (event.type === "chat.completed" || event.type === "chat.failed") {
      pendingQById.clear();
    }
  }

  return Array.from(pendingQById.values()).sort((a, b) => a.idx - b.idx);
}

export function derivePendingPlan(events: ChatEvent[]): PendingPlan | null {
  const orderedEvents = toOrderedEvents(events);
  let latestPlan: PendingPlan | null = null;

  for (const event of orderedEvents) {
    if (event.type === "plan.created") {
      const normalizedPlan = normalizePlanCreatedEvent(event, orderedEvents);
      if (!normalizedPlan) {
        continue;
      }

      latestPlan = {
        content: normalizedPlan.content,
        filePath: normalizedPlan.filePath,
        createdIdx: normalizedPlan.idx,
        status: "pending",
      };
      continue;
    }

    if (event.type === "plan.approved") {
      if (latestPlan) {
        latestPlan = { ...latestPlan, status: "approved" };
      }
      continue;
    }

    if (event.type === "plan.dismissed") {
      latestPlan = null;
      continue;
    }

    if (event.type === "plan.revision_requested") {
      if (latestPlan) {
        latestPlan = { ...latestPlan, status: "sending" };
      }
    }
  }

  return latestPlan;
}

function getFinishedToolNames(
  event: ChatEvent,
  toolNameByUseId: Map<string, string>,
): string[] {
  if (event.type !== "tool.finished") {
    return [];
  }

  const directToolName = typeof event.payload.toolName === "string"
    ? event.payload.toolName.trim().toLowerCase()
    : "";
  if (directToolName.length > 0) {
    return [directToolName];
  }

  const precedingToolUseIds = Array.isArray(event.payload.precedingToolUseIds)
    ? event.payload.precedingToolUseIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];

  return precedingToolUseIds
    .map((toolUseId) => toolNameByUseId.get(toolUseId) ?? "")
    .filter((toolName) => toolName.length > 0);
}

function findPlanReviewReadyIdx(events: ChatEvent[], pendingPlan: PendingPlan | null): number | null {
  if (!pendingPlan || pendingPlan.status !== "pending") {
    return null;
  }

  const orderedEvents = toOrderedEvents(events);
  const toolNameByUseId = new Map<string, string>();
  let fallbackCompletionIdx: number | null = null;

  for (const event of orderedEvents) {
    if (event.idx <= pendingPlan.createdIdx) {
      if (event.type === "tool.started") {
        const toolUseId = typeof event.payload.toolUseId === "string" ? event.payload.toolUseId : "";
        const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName.trim().toLowerCase() : "";
        if (toolUseId.length > 0 && toolName.length > 0) {
          toolNameByUseId.set(toolUseId, toolName);
        }
      }
      continue;
    }

    if (event.type === "tool.started") {
      const toolUseId = typeof event.payload.toolUseId === "string" ? event.payload.toolUseId : "";
      const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName.trim().toLowerCase() : "";
      if (toolUseId.length > 0 && toolName.length > 0) {
        toolNameByUseId.set(toolUseId, toolName);
      }
      continue;
    }

    if (event.type === "tool.finished") {
      const finishedToolNames = getFinishedToolNames(event, toolNameByUseId);
      if (finishedToolNames.some((toolName) => toolName === "exitplanmode")) {
        return event.idx;
      }
      continue;
    }

    if ((event.type === "chat.completed" || event.type === "chat.failed") && fallbackCompletionIdx == null) {
      fallbackCompletionIdx = event.idx;
    }
  }

  return fallbackCompletionIdx;
}

export function isPlanReviewReady(events: ChatEvent[], pendingPlan: PendingPlan | null): boolean {
  return findPlanReviewReadyIdx(events, pendingPlan) != null;
}

export function deriveThreadUiStatusFromEvents(
  events: ChatEvent[],
  isActive: boolean,
): WorktreeThreadUiStatus {
  const hasPendingPermissionRequests = derivePendingPermissionRequests(events).length > 0;
  const hasPendingQuestionRequests = derivePendingQuestionRequests(events).length > 0;

  if (hasPendingPermissionRequests || hasPendingQuestionRequests) {
    return "waiting_approval";
  }

  const pendingPlan = derivePendingPlan(events);
  if (pendingPlan?.status === "pending" && isPlanReviewReady(events, pendingPlan)) {
    return "review_plan";
  }

  if (isActive || hasRunningAssistantActivity(events)) {
    return "running";
  }

  return "idle";
}

export function deriveThreadUiStatus(thread: ChatThread, snapshot: ChatThreadSnapshot | null | undefined): WorktreeThreadUiStatus {
  return deriveThreadUiStatusFromEvents(snapshot?.events ?? [], thread.active);
}

const WORKTREE_STATUS_PRIORITY: WorktreeThreadUiStatus[] = [
  "waiting_approval",
  "review_plan",
  "running",
  "idle",
];

export function aggregateWorktreeStatus(
  threadSummaries: Array<{ thread: ChatThread; snapshot: ChatThreadSnapshot | null | undefined }>,
): WorktreeStatusSummary {
  let bestStatus: WorktreeThreadUiStatus = "idle";
  let bestThreadId: string | null = null;

  for (const summary of threadSummaries) {
    const status = deriveThreadUiStatus(summary.thread, summary.snapshot);
    if (WORKTREE_STATUS_PRIORITY.indexOf(status) < WORKTREE_STATUS_PRIORITY.indexOf(bestStatus)) {
      bestStatus = status;
      bestThreadId = summary.thread.id;
    }
  }

  return {
    kind: bestStatus,
    threadId: bestThreadId,
  };
}
