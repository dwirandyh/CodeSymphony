export function resolveThreadIdOnSelectionChange(args: {
  worktreeChanged: boolean;
  shouldReusePendingThreadId: boolean;
  pendingThreadId?: string | null;
  routeThreadId?: string | null;
  restoredThreadId?: string | null;
  nextWorktreeId: string | null;
  routeWorktreeId?: string | null;
  restoredWorktreeId?: string | null;
}): { threadId?: string } {
  if (args.shouldReusePendingThreadId) {
    return { threadId: args.pendingThreadId ?? undefined };
  }

  if (!args.worktreeChanged) {
    return {};
  }

  const intendedWorktreeId = args.routeWorktreeId ?? args.restoredWorktreeId ?? null;
  const routeThreadId = args.routeThreadId ?? args.restoredThreadId ?? undefined;
  const navigatingToIntendedWorktree =
    args.nextWorktreeId != null
    && intendedWorktreeId != null
    && args.nextWorktreeId === intendedWorktreeId;

  if (navigatingToIntendedWorktree && routeThreadId) {
    return { threadId: routeThreadId };
  }

  return { threadId: undefined };
}

export function shouldSuppressStartupFallbackSearchUpdate(args: {
  startupSelectionFallbackActive: boolean;
  routeRepoId: string | null;
  routeWorktreeId: string | null;
  pendingRepoId: string | null;
  pendingWorktreeId: string | null;
  restoredRepoId: string | null;
  restoredWorktreeId: string | null;
  nextRepoId: string | null;
  nextWorktreeId: string | null;
}): boolean {
  if (!args.startupSelectionFallbackActive) {
    return false;
  }

  if (args.routeRepoId != null || args.routeWorktreeId != null) {
    return false;
  }

  if (args.pendingRepoId != null || args.pendingWorktreeId != null) {
    return false;
  }

  return args.nextRepoId === args.restoredRepoId
    && args.nextWorktreeId === args.restoredWorktreeId
    && (args.restoredRepoId != null || args.restoredWorktreeId != null);
}
