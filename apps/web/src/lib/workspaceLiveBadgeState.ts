import type { WorkspaceLiveConnectionState } from "@codesymphony/shared-types";
import { formatLiveUpdateStateLabel } from "./liveUpdatePolicy";

export type LiveStatusDisplayState = WorkspaceLiveConnectionState | "switching" | "unavailable";

export type WorkspaceLiveScopeSelection = {
  repositoryId: string | null;
  threadId: string | null;
  worktreeId: string | null;
};

export type WorkspaceLiveScopeSwitch = {
  repositoryChanged: boolean;
  startedAtMs: number;
  threadChanged: boolean;
  worktreeChanged: boolean;
};

export const WORKSPACE_LIVE_SCOPE_SWITCH_MAX_MS = 15_000;

const LIVE_STATUS_DISPLAY_STATE_SEVERITY: Record<LiveStatusDisplayState, number> = {
  healthy: 0,
  connecting: 1,
  switching: 2,
  reconnecting: 3,
  stale: 4,
  exhausted: 5,
  unavailable: 5,
};

export function createWorkspaceLiveScopeSwitch(
  previousSelection: WorkspaceLiveScopeSelection,
  nextSelection: WorkspaceLiveScopeSelection,
  startedAtMs: number,
): WorkspaceLiveScopeSwitch | null {
  const repositoryChanged = previousSelection.repositoryId !== nextSelection.repositoryId;
  const worktreeChanged = previousSelection.worktreeId !== nextSelection.worktreeId;
  const threadChanged = previousSelection.threadId !== nextSelection.threadId;

  if (!repositoryChanged && !worktreeChanged && !threadChanged) {
    return null;
  }

  return {
    repositoryChanged,
    startedAtMs,
    threadChanged,
    worktreeChanged,
  };
}

export function isUnavailableWorktreeErrorMessage(message: string | null | undefined) {
  if (!message) {
    return false;
  }

  return message === "Worktree is still being prepared. Please wait until it is ready."
    || message === "Worktree is being deleted."
    || message === "Worktree is archived."
    || message.startsWith("Worktree creation failed. Delete it and create a new worktree.")
    || message.startsWith("Worktree path not found:")
    || message.startsWith("Worktree path is not a directory:")
    || message === "Worktree is not available.";
}

export function isLiveStatusTransitionState(state: WorkspaceLiveConnectionState | null | undefined) {
  return state === "connecting" || state === "reconnecting";
}

function isLiveStatusPendingDuringScopeSwitch(state: WorkspaceLiveConnectionState | null | undefined) {
  return state === "connecting" || state === "reconnecting" || state === "stale";
}

export function shouldKeepWorkspaceLiveScopeSwitch(params: {
  chatThreadState: WorkspaceLiveConnectionState | null;
  gitStatusState: WorkspaceLiveConnectionState | null;
  hasChatThreadSelection: boolean;
  hasRepositorySelection: boolean;
  hasWorktreeSelection: boolean;
  nowMs: number;
  repositoryBranchesState: WorkspaceLiveConnectionState | null;
  repositoryReviewsState: WorkspaceLiveConnectionState | null;
  transition: WorkspaceLiveScopeSwitch;
}) {
  const {
    chatThreadState,
    gitStatusState,
    hasChatThreadSelection,
    hasRepositorySelection,
    hasWorktreeSelection,
    nowMs,
    repositoryBranchesState,
    repositoryReviewsState,
    transition,
  } = params;

  if (nowMs - transition.startedAtMs >= WORKSPACE_LIVE_SCOPE_SWITCH_MAX_MS) {
    return false;
  }

  const chatPending = (transition.threadChanged || transition.worktreeChanged)
    && hasChatThreadSelection
    && isLiveStatusPendingDuringScopeSwitch(chatThreadState);
  const gitPending = transition.worktreeChanged
    && hasWorktreeSelection
    && isLiveStatusPendingDuringScopeSwitch(gitStatusState);
  const repositoryReviewsPending = transition.repositoryChanged
    && hasRepositorySelection
    && isLiveStatusPendingDuringScopeSwitch(repositoryReviewsState);
  const repositoryBranchesPending = transition.repositoryChanged
    && hasRepositorySelection
    && isLiveStatusPendingDuringScopeSwitch(repositoryBranchesState);

  return chatPending || gitPending || repositoryReviewsPending || repositoryBranchesPending;
}

export function resolveLiveStatusDisplayState(input: {
  connectionState: WorkspaceLiveConnectionState | null;
  displayStateOverride?: LiveStatusDisplayState | null;
  errorMessage?: string | null;
}): LiveStatusDisplayState | null {
  const { connectionState, displayStateOverride, errorMessage } = input;
  if (connectionState === null) {
    return null;
  }

  if (connectionState === "exhausted" && isUnavailableWorktreeErrorMessage(errorMessage)) {
    return "unavailable";
  }

  if (
    displayStateOverride === "switching"
    && isLiveStatusPendingDuringScopeSwitch(connectionState)
  ) {
    return "switching";
  }

  return connectionState;
}

export function compareLiveStatusDisplayStateSeverity(
  left: LiveStatusDisplayState,
  right: LiveStatusDisplayState,
) {
  return LIVE_STATUS_DISPLAY_STATE_SEVERITY[left] - LIVE_STATUS_DISPLAY_STATE_SEVERITY[right];
}

export function formatLiveStatusDisplayStateLabel(state: LiveStatusDisplayState) {
  if (state === "switching") {
    return "Switching";
  }

  if (state === "unavailable") {
    return "Unavailable";
  }

  return formatLiveUpdateStateLabel(state);
}
