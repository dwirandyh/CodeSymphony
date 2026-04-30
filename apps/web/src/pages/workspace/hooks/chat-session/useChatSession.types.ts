import type { ChatMode } from "@codesymphony/shared-types";
import type { WorktreeThreadUiStatus } from "../worktreeThreadStatus";

export type PendingMessageMutation =
  | { kind: "ensure-placeholder"; id: string; threadId: string }
  | {
    kind: "message-delta";
    id: string;
    threadId: string;
    role: "assistant" | "user";
    delta: string;
    eventIdx?: number;
  };

export type SnapshotSeedMode = "replace" | "merge";

export type SnapshotSeedDecision = {
  shouldApply: boolean;
  reason:
    | "thread-changed"
    | "no-thread-or-snapshot"
    | "same-snapshot-key"
    | "snapshot-key-changed"
    | "local-state-ahead"
    | "local-message-ahead-while-waiting"
    | "pending-user-gate";
  snapshotKey: string | null;
};

export type ThreadMetadataSnapshot = {
  threadTitle: string | null;
  worktreeBranch: string | null;
};

export interface UseChatSessionOptions {
  desiredThreadId?: string;
  desiredWorktreeId?: string | null;
  repositoryId?: string | null;
  worktreeStatus?: "active" | "archived" | "creating" | "create_failed" | "deleting" | "delete_failed" | null;
  onThreadChange?: (threadId: string | null) => void;
  timelineEnabled?: boolean;
}

type SelectedThreadUiState = {
  selectedThreadUiStatus: WorktreeThreadUiStatus;
  composerDisabled: boolean;
};
