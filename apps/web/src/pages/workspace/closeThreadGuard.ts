import type { ChatThread } from "@codesymphony/shared-types";

interface ShouldConfirmCloseThreadParams {
  threadId: string;
  selectedThreadId: string | null;
  showStopAction: boolean;
  waitingAssistantThreadId: string | null;
  threads: ChatThread[];
}

export function shouldConfirmCloseThread({
  threadId,
  selectedThreadId,
  showStopAction,
  waitingAssistantThreadId,
  threads,
}: ShouldConfirmCloseThreadParams): boolean {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return false;
  }

  const waitingForTargetThread = waitingAssistantThreadId === threadId;

  if (threadId === selectedThreadId) {
    return showStopAction || waitingForTargetThread || targetThread.active;
  }

  return waitingForTargetThread || targetThread.active;
}
