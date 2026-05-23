import type { WorkspaceStartupRuntimeState } from "../../components/startup/workspaceStartupState";

export function shouldClearPersistedStartupShell(params: {
  criticalWorkspaceDataEnabled: boolean;
  hasLiveShellData: boolean;
  hasUnavailableSelectedWorktree: boolean;
  loadingRepos: boolean;
  repositoriesCount: number;
  runtimeState: WorkspaceStartupRuntimeState;
}) {
  if (params.hasLiveShellData) {
    return false;
  }

  if (!params.criticalWorkspaceDataEnabled) {
    return false;
  }

  if (params.hasUnavailableSelectedWorktree) {
    return !params.loadingRepos;
  }

  return params.runtimeState === "ready"
    && !params.loadingRepos
    && params.repositoriesCount === 0;
}

export function shouldPreserveStartupThreadFallback(params: {
  threadFallbackActive: boolean;
  loadingRepos: boolean;
  messageListEmptyState: string | null;
  runtimeState: WorkspaceStartupRuntimeState;
}) {
  if (!params.threadFallbackActive) {
    return false;
  }

  if (params.runtimeState !== "ready" || params.loadingRepos) {
    return true;
  }

  return params.messageListEmptyState !== "no-thread-selected";
}

export function shouldReleaseStartupSelectionFallback(params: {
  loadingRepos: boolean;
  messageListEmptyState: string | null;
  runtimeState: WorkspaceStartupRuntimeState;
  selectedThreadId: string | null;
  selectedWorktreeId: string | null;
  selectionFallbackActive: boolean;
}) {
  if (!params.selectionFallbackActive) {
    return false;
  }

  if (params.runtimeState !== "ready" || params.loadingRepos || !params.selectedWorktreeId) {
    return false;
  }

  if (params.selectedThreadId != null) {
    return true;
  }

  return params.messageListEmptyState === "no-thread-selected";
}
