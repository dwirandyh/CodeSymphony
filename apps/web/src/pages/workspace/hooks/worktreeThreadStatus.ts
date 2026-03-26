import type { ChatEvent, ChatThread, ChatThreadSnapshot } from "@codesymphony/shared-types";
import type { PendingPermissionRequest, PendingPlan, PendingQuestionRequest, QuestionItem } from "../types";
import { shortenReadTargetForDisplay } from "../exploreUtils";
import { isAcpPlanFallbackPath, isPlanFilePath, payloadStringOrNull } from "../eventUtils";

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
      const questions: QuestionItem[] = rawQuestions.map((q: Record<string, unknown>, index) => ({
        id: typeof q.id === "string" && q.id.trim().length > 0 ? q.id.trim() : `q-${index}`,
        question: typeof q.question === "string" ? q.question : "",
        header: typeof q.header === "string" ? q.header : undefined,
        options: Array.isArray(q.options)
          ? q.options.map((o: Record<string, unknown>) => ({
            label: typeof o.label === "string" ? o.label : "",
            description: typeof o.description === "string" ? o.description : undefined,
            preview: typeof o.preview === "string" ? o.preview : undefined,
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
      const content = typeof event.payload.content === "string" ? event.payload.content : "";
      const filePath = typeof event.payload.filePath === "string" ? event.payload.filePath : "";
      if (content.length === 0) {
        continue;
      }

      if (event.payload.source === "streaming_fallback" && !isPlanFilePath(filePath) && !isAcpPlanFallbackPath(filePath)) {
        const realWrite = orderedEvents.find((candidate) =>
          candidate.idx > event.idx
          && candidate.type === "tool.finished"
          && isPlanFilePath(
            payloadStringOrNull(candidate.payload.editTarget)
              ?? payloadStringOrNull(candidate.payload.file_path)
              ?? "",
          ));
        if (!realWrite) {
          continue;
        }

        const toolInput = isRecord(realWrite.payload.toolInput) ? realWrite.payload.toolInput : null;
        const realContent = toolInput ? payloadStringOrNull(toolInput.content) : null;
        const realPath = payloadStringOrNull(realWrite.payload.editTarget)
          ?? payloadStringOrNull(realWrite.payload.file_path)
          ?? filePath;
        if (!realContent || realContent.trim().length === 0) {
          continue;
        }

        latestPlan = { content: realContent, filePath: realPath, createdIdx: realWrite.idx, status: "pending" };
        continue;
      }

      latestPlan = { content, filePath, createdIdx: event.idx, status: "pending" };
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

export function isRunCompletedAfterPlan(events: ChatEvent[], pendingPlan: PendingPlan | null): boolean {
  if (!pendingPlan || pendingPlan.status !== "pending") {
    return true;
  }

  const orderedEvents = toOrderedEvents(events);
  return orderedEvents.some((event) =>
    event.idx > pendingPlan.createdIdx
    && (event.type === "chat.completed" || event.type === "chat.failed"));
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
  if (pendingPlan?.status === "pending" && isRunCompletedAfterPlan(events, pendingPlan)) {
    return "review_plan";
  }

  if (isActive) {
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
