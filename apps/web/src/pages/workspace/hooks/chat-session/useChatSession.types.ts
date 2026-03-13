import type { ChatMode } from "@codesymphony/shared-types";

export type PendingMessageMutation =
  | { kind: "ensure-placeholder"; id: string; threadId: string }
  | { kind: "message-delta"; id: string; threadId: string; role: "assistant" | "user"; delta: string };

export type SnapshotSeedMode = "replace" | "merge";

export type SnapshotSeedDecision = {
  shouldApply: boolean;
  reason:
    | "thread-changed"
    | "no-thread-or-snapshot"
    | "same-snapshot-key"
    | "snapshot-key-changed"
    | "local-state-ahead"
    | "pending-user-gate";
  snapshotKey: string | null;
};

export type ThreadMetadataSnapshot = {
  threadTitle: string | null;
  worktreeBranch: string | null;
};

export interface UseChatSessionOptions {
  initialThreadId?: string;
  onThreadChange?: (threadId: string | null) => void;
  selectedRepositoryId?: string | null;
  onWorktreeResolved?: (worktreeId: string) => void;
  timelineEnabled?: boolean;
}
