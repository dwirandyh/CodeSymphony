import type { WorkspaceLiveConnectionState } from "@codesymphony/shared-types";

export type LiveUpdateMechanism =
  | "thread_event_stream"
  | "workspace_live_resource"
  | "workspace_live_socket"
  | "workspace_sync_bus";
export type LiveUpdateReplayStrategy = "persisted_event_replay" | "snapshot_over_stream" | "invalidate_only";
export type LiveUpdateDomainId =
  | "chat_thread"
  | "git_status"
  | "repository_branches"
  | "repository_reviews"
  | "automation_runs"
  | "workspace_sync";

export type LiveUpdateDomainPolicy = {
  label: string;
  mechanism: LiveUpdateMechanism;
  replayStrategy: LiveUpdateReplayStrategy;
};

export const LIVE_UPDATE_DOMAIN_POLICY: Record<LiveUpdateDomainId, LiveUpdateDomainPolicy> = {
  chat_thread: {
    label: "Chat stream",
    mechanism: "thread_event_stream",
    replayStrategy: "persisted_event_replay",
  },
  git_status: {
    label: "Git status",
    mechanism: "workspace_live_socket",
    replayStrategy: "snapshot_over_stream",
  },
  repository_branches: {
    label: "Repository branches",
    mechanism: "workspace_live_socket",
    replayStrategy: "snapshot_over_stream",
  },
  repository_reviews: {
    label: "Repository reviews",
    mechanism: "workspace_live_socket",
    replayStrategy: "snapshot_over_stream",
  },
  automation_runs: {
    label: "Automation runs",
    mechanism: "workspace_live_resource",
    replayStrategy: "snapshot_over_stream",
  },
  workspace_sync: {
    label: "Workspace sync",
    mechanism: "workspace_sync_bus",
    replayStrategy: "invalidate_only",
  },
};

const LIVE_UPDATE_STATE_SEVERITY: Record<WorkspaceLiveConnectionState, number> = {
  healthy: 0,
  connecting: 1,
  reconnecting: 2,
  stale: 3,
  exhausted: 4,
};

export function formatLiveUpdateStateLabel(state: WorkspaceLiveConnectionState) {
  switch (state) {
    case "healthy":
      return "Live";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "stale":
      return "Stale";
    case "exhausted":
      return "Exhausted";
    default:
      return state;
  }
}

export function formatLiveUpdateMechanismLabel(mechanism: LiveUpdateMechanism) {
  switch (mechanism) {
    case "thread_event_stream":
      return "thread stream";
    case "workspace_live_resource":
      return "live resource";
    case "workspace_live_socket":
      return "workspace socket";
    case "workspace_sync_bus":
      return "workspace sync bus";
    default:
      return mechanism;
  }
}

export function formatLiveUpdateReplayLabel(replayStrategy: LiveUpdateReplayStrategy) {
  switch (replayStrategy) {
    case "persisted_event_replay":
      return "persisted replay";
    case "snapshot_over_stream":
      return "snapshot stream";
    case "invalidate_only":
      return "coarse sync";
    default:
      return replayStrategy;
  }
}

export function compareLiveUpdateStateSeverity(
  left: WorkspaceLiveConnectionState,
  right: WorkspaceLiveConnectionState,
) {
  return LIVE_UPDATE_STATE_SEVERITY[left] - LIVE_UPDATE_STATE_SEVERITY[right];
}
