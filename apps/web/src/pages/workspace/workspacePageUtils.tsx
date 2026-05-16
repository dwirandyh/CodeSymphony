import type { ChatEvent, ChatTimelineItem } from "@codesymphony/shared-types";
import type { ChatWorkingStatus } from "../../components/workspace/chat-message-list";
import type { ChatMessageListEmptyState } from "../../components/workspace/chat-message-list/ChatMessageList.types";

export type WorkspaceThreadlessFallbackSurface =
  | { kind: "empty" }
  | { kind: "file"; filePath: string }
  | { kind: "terminal"; terminalTabId: string }
  | { kind: "review" };

export function resolveChatMessageListKey(params: {
  previousKey: string;
  previousThreadId: string | null;
  nextThreadId: string | null;
}): string {
  const { previousKey, nextThreadId } = params;

  if (nextThreadId == null) {
    return previousKey;
  }

  if (previousKey !== nextThreadId) {
    return nextThreadId;
  }

  return previousKey;
}

export function shouldShowThinkingPlaceholder(params: {
  selectedThreadUiStatus: string;
  isWaitingForUserGate: boolean;
  timelineItems: ChatTimelineItem[];
  workingStatus?: ChatWorkingStatus | null;
}): boolean {
  if (params.isWaitingForUserGate) {
    return false;
  }

  return params.selectedThreadUiStatus === "running" || params.workingStatus?.state === "completed";
}

export function shouldShowWorkspaceEmptyState(params: {
  activeView: "chat" | "file" | "review" | "automations";
  hasOpenContentTabs: boolean;
  terminalViewActive: boolean;
  messageListEmptyState: ChatMessageListEmptyState | null;
}): boolean {
  if (params.activeView !== "chat" || params.terminalViewActive) {
    return false;
  }

  if (params.hasOpenContentTabs) {
    return false;
  }

  return params.messageListEmptyState === "no-thread-selected" || params.messageListEmptyState === "creating-thread";
}

export function resolveWorkspaceThreadlessFallbackSurface(params: {
  activeTerminalTabId: string | null;
  openFilePaths: string[];
  openTerminalTabIds: string[];
  recentFilePaths: string[];
  reviewOpen: boolean;
}): WorkspaceThreadlessFallbackSurface {
  const openFilePathSet = new Set(params.openFilePaths);
  const recentOpenFilePath = params.recentFilePaths.find((filePath) => openFilePathSet.has(filePath));
  if (recentOpenFilePath) {
    return {
      kind: "file",
      filePath: recentOpenFilePath,
    };
  }

  const fallbackOpenFilePath = params.openFilePaths[params.openFilePaths.length - 1] ?? null;
  if (fallbackOpenFilePath) {
    return {
      kind: "file",
      filePath: fallbackOpenFilePath,
    };
  }

  const activeTerminalTabId = params.activeTerminalTabId;
  if (activeTerminalTabId && params.openTerminalTabIds.includes(activeTerminalTabId)) {
    return {
      kind: "terminal",
      terminalTabId: activeTerminalTabId,
    };
  }

  const fallbackTerminalTabId = params.openTerminalTabIds[0] ?? null;
  if (fallbackTerminalTabId) {
    return {
      kind: "terminal",
      terminalTabId: fallbackTerminalTabId,
    };
  }

  if (params.reviewOpen) {
    return { kind: "review" };
  }

  return { kind: "empty" };
}

export function shouldReturnToWorkspaceLandingAfterClosingContent(
  messageListEmptyState: ChatMessageListEmptyState | null,
): boolean {
  return (
    messageListEmptyState === "no-thread-selected"
    || messageListEmptyState === "creating-thread"
    || messageListEmptyState === "new-thread-empty"
    || messageListEmptyState === "existing-thread-empty"
  );
}

export function buildInitialWorkspaceLandingHoldState(params: {
  routeWorktreeId: string | null | undefined;
  routeThreadId: string | null | undefined;
}): Record<string, boolean> {
  if (!params.routeWorktreeId || params.routeThreadId != null) {
    return {};
  }

  return { [params.routeWorktreeId]: true };
}

function getTimelineItemCreatedAt(item: ChatTimelineItem): string | null {
  switch (item.kind) {
    case "message":
      return item.message.createdAt;
    case "plan-file-output":
    case "todo-list":
    case "todo-progress":
      return item.createdAt;
    case "edited-diff":
      return item.createdAt;
    case "tool":
      return item.event?.createdAt ?? item.sourceEvents?.[0]?.createdAt ?? null;
    case "error":
      return item.createdAt;
    default:
      return null;
  }
}

function findLatestUserMessageCreatedAt(items: ChatTimelineItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "message" && item.message.role === "user") {
      return item.message.createdAt;
    }
  }
  return null;
}

function findLatestRunningItem(items: ChatTimelineItem[]): ChatTimelineItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || !("status" in item)) {
      continue;
    }
    if (item.status === "running") {
      return item;
    }
  }
  return null;
}

function findLatestTerminalEventAfter(events: ChatEvent[], startedAt: string | null): ChatEvent | null {
  const startedAtMs = startedAt ? Date.parse(startedAt) : NaN;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || (event.type !== "chat.completed" && event.type !== "chat.failed")) {
      continue;
    }
    const eventMs = Date.parse(event.createdAt);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(eventMs) || eventMs >= startedAtMs) {
      return event;
    }
  }
  return null;
}

function workingLabelForItem(item: ChatTimelineItem | null): string {
  if (!item) {
    return "Thinking";
  }

  switch (item.kind) {
    case "edited-diff":
      return "Editing";
    case "explore-activity":
      return "Exploring";
    case "subagent-activity":
      return "Delegating";
    case "todo-list":
      return "Working";
    case "todo-progress":
      return "Working";
    case "tool":
      if (item.shell === "bash") {
        return "Running command";
      }
      return item.toolName ? `Using ${item.toolName}` : "Using tool";
    case "message":
      return item.message.role === "assistant" ? "Working" : "Thinking";
    default:
      return "Working";
  }
}

export function deriveWorkingStatus(params: {
  events?: ChatEvent[];
  selectedThreadUiStatus?: string;
  timelineItems: ChatTimelineItem[];
}): ChatWorkingStatus | null {
  const runningItem = findLatestRunningItem(params.timelineItems);
  const lastItem = params.timelineItems[params.timelineItems.length - 1] ?? null;
  const startedAt =
    findLatestUserMessageCreatedAt(params.timelineItems)
    ?? (runningItem ? getTimelineItemCreatedAt(runningItem) : null)
    ?? (lastItem ? getTimelineItemCreatedAt(lastItem) : null);

  if (!startedAt) {
    return null;
  }

  if (params.selectedThreadUiStatus === "running") {
    const label =
      !runningItem
        && lastItem?.kind === "message"
        && lastItem.message.role === "user"
        ? "Waiting for response"
        : workingLabelForItem(runningItem ?? lastItem);
    return {
      label,
      startedAt,
      finishedAt: null,
      state: "running",
    };
  }

  const terminalEvent = findLatestTerminalEventAfter(params.events ?? [], startedAt);
  if (!terminalEvent) {
    return null;
  }

  return {
    label: "Worked",
    startedAt,
    finishedAt: terminalEvent.createdAt,
    state: "completed",
  };
}


export function FilledPlayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path fill="currentColor" d="M4 2.5v11l9-5.5-9-5.5z" />
    </svg>
  );
}

export function FilledPauseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <rect x="3.5" y="2.5" width="3.5" height="11" rx="0.8" fill="currentColor" />
      <rect x="9" y="2.5" width="3.5" height="11" rx="0.8" fill="currentColor" />
    </svg>
  );
}
