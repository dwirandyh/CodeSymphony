export type ThreadCloseShortcutMessageListEmptyState =
  | "no-thread-selected"
  | "creating-thread"
  | "loading-thread"
  | "new-thread-empty"
  | "existing-thread-empty"
  | null;

export type MacCloseShortcutTarget = "thread" | "file" | "review" | null;

interface ResolveMacCloseShortcutTargetParams {
  activeView: "chat" | "file" | "review";
  selectedThreadId: string | null;
  activeFilePath: string | null;
  threadCount: number;
  messageListEmptyState: ThreadCloseShortcutMessageListEmptyState;
}

export function resolveMacCloseShortcutTarget({
  activeView,
  selectedThreadId,
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
