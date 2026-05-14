export type ThreadCloseShortcutMessageListEmptyState =
  | "no-thread-selected"
  | "creating-thread"
  | "loading-thread"
  | "new-thread-empty"
  | "existing-thread-empty"
  | null;

export type MacCloseShortcutTarget = "thread" | "terminal" | "file" | "review" | "automations" | null;

interface ResolveMacCloseShortcutTargetParams {
  activeView: "chat" | "file" | "review" | "automations";
  selectedThreadId: string | null;
  activeTerminalTabId: string | null;
  activeFilePath: string | null;
  threadCount: number;
  messageListEmptyState: ThreadCloseShortcutMessageListEmptyState;
}

export function resolveMacCloseShortcutTarget({
  activeView,
  selectedThreadId,
  activeTerminalTabId,
  activeFilePath,
  threadCount,
  messageListEmptyState,
}: ResolveMacCloseShortcutTargetParams): MacCloseShortcutTarget {
  if (activeView === "file") {
    return activeFilePath ? "file" : null;
  }

  if (activeView === "review") {
    return "review";
  }

  if (activeView === "automations") {
    return "automations";
  }

  if (activeTerminalTabId) {
    return "terminal";
  }

  if (!selectedThreadId || threadCount === 0) {
    return null;
  }

  const lastThreadIsDefinitelyEmpty =
    threadCount === 1
    && (
      messageListEmptyState === "new-thread-empty"
      || messageListEmptyState === "existing-thread-empty"
    );

  return lastThreadIsDefinitelyEmpty ? null : "thread";
}
