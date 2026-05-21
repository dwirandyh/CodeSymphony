function hasText(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasStartupWorkspaceShellReadyState(params: {
  repositoryId: string | null;
  repositoryName: string | null;
  worktreeId: string | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
}) {
  const hasWorkspaceSelection = !!(params.repositoryId || params.worktreeId);
  if (!hasWorkspaceSelection) {
    return false;
  }

  if (params.repositoryId && !hasText(params.repositoryName)) {
    return false;
  }

  if (params.worktreeId && !hasText(params.worktreeBranch) && !hasText(params.worktreePath)) {
    return false;
  }

  return true;
}

export function hasStartupThreadShellReadyState(params: {
  threadId: string | null;
  threadTitle: string | null;
}) {
  return !!params.threadId && hasText(params.threadTitle);
}

export function hasStartupNonCriticalDataReadyState(params: {
  workspaceShellReady: boolean;
  startupThreadId: string | null;
  messageListEmptyState: string | null;
  repositoriesLoading: boolean;
  selectedRepositoryId: string | null;
  selectedWorktreeId: string | null;
  selectedThreadId: string | null;
}) {
  const emptyWorkspaceSettled = !params.repositoriesLoading
    && !params.selectedRepositoryId
    && !params.selectedWorktreeId
    && !params.selectedThreadId;

  if (emptyWorkspaceSettled) {
    return true;
  }

  if (!params.workspaceShellReady) {
    return false;
  }

  if (!params.startupThreadId) {
    return true;
  }

  return params.messageListEmptyState !== "loading-thread"
    && params.messageListEmptyState !== "creating-thread"
    && params.messageListEmptyState !== "no-thread-selected";
}
