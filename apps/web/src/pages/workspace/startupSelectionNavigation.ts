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
