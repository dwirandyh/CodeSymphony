import type {
  PendingPermissionEntry,
  PendingQuestionEntry,
  PermissionDecisionResult,
  QuestionAnswerResult,
} from "./chatService.types.js";

export function ensureThreadPermissionMap(
  pendingPermissionsByThread: Map<string, Map<string, PendingPermissionEntry>>,
  threadId: string,
): Map<string, PendingPermissionEntry> {
  const existing = pendingPermissionsByThread.get(threadId);
  if (existing) {
    return existing;
  }

  const created = new Map<string, PendingPermissionEntry>();
  pendingPermissionsByThread.set(threadId, created);
  return created;
}

export function rejectPendingPermissions(
  pendingPermissionsByThread: Map<string, Map<string, PendingPermissionEntry>>,
  threadId: string,
  message: string,
): number {
  const pendingMap = pendingPermissionsByThread.get(threadId);
  if (!pendingMap) {
    return 0;
  }

  pendingPermissionsByThread.delete(threadId);
  let rejectedCount = 0;
  for (const pending of pendingMap.values()) {
    if (pending.status !== "pending" || !pending.reject) {
      continue;
    }
    pending.status = "resolved";
    const reject = pending.reject;
    pending.resolve = undefined;
    pending.reject = undefined;
    rejectedCount += 1;
    reject(new Error(message));
  }

  return rejectedCount;
}

export function ensureThreadQuestionMap(
  pendingQuestionsByThread: Map<string, Map<string, PendingQuestionEntry>>,
  threadId: string,
): Map<string, PendingQuestionEntry> {
  const existing = pendingQuestionsByThread.get(threadId);
  if (existing) {
    return existing;
  }

  const created = new Map<string, PendingQuestionEntry>();
  pendingQuestionsByThread.set(threadId, created);
  return created;
}

export function rejectPendingQuestions(
  pendingQuestionsByThread: Map<string, Map<string, PendingQuestionEntry>>,
  threadId: string,
  message: string,
): number {
  const pendingMap = pendingQuestionsByThread.get(threadId);
  if (!pendingMap) {
    return 0;
  }

  pendingQuestionsByThread.delete(threadId);
  let rejectedCount = 0;
  for (const pending of pendingMap.values()) {
    if (pending.status !== "pending" || !pending.reject) {
      continue;
    }
    pending.status = "resolved";
    const reject = pending.reject;
    pending.resolve = undefined;
    pending.reject = undefined;
    rejectedCount += 1;
    reject(new Error(message));
  }

  return rejectedCount;
}

export function cancelPendingGateRequests(
  pendingPermissionsByThread: Map<string, Map<string, PendingPermissionEntry>>,
  pendingQuestionsByThread: Map<string, Map<string, PendingQuestionEntry>>,
  threadId: string,
): boolean {
  const rejectedPermissions = rejectPendingPermissions(pendingPermissionsByThread, threadId, "Permission request cancelled by user.");
  const rejectedQuestions = rejectPendingQuestions(pendingQuestionsByThread, threadId, "Question cancelled by user.");
  return rejectedPermissions > 0 || rejectedQuestions > 0;
}

export function clearPendingGateRequestsBecauseRunEnded(
  pendingPermissionsByThread: Map<string, Map<string, PendingPermissionEntry>>,
  pendingQuestionsByThread: Map<string, Map<string, PendingQuestionEntry>>,
  threadId: string,
): void {
  rejectPendingPermissions(pendingPermissionsByThread, threadId, "Permission request cancelled because the chat run ended.");
  rejectPendingQuestions(pendingQuestionsByThread, threadId, "Question cancelled because the chat run ended.");
}
