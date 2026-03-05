import type { ChatMode } from "@codesymphony/shared-types";
import type { SemanticBoundary } from "../../eventUtils";

export type PendingMessageMutation =
  | { kind: "ensure-placeholder"; id: string; threadId: string }
  | { kind: "message-delta"; id: string; threadId: string; role: "assistant" | "user"; delta: string };

export type LoadOlderHistoryRequestMetadata = {
  cycleId?: number;
  requestId?: string;
  source?: "manual" | "auto-hydration";
  eventsLimitOverride?: number;
};

export type LoadOlderHistoryResult = {
  cycleId: number | null;
  requestId: string;
  completionReason: "applied" | "empty-cursors" | "thread-changed";
  messagesAdded: number;
  eventsAdded: number;
  estimatedRenderableGrowth: boolean;
  source: "manual" | "auto-hydration";
  semanticBoundaryDetected: boolean;
  semanticBoundary: SemanticBoundary | null;
};

export type SemanticHydrationGateMetadata = {
  threadId: string | null;
  reason: "load-older-history" | "auto-backfill" | "thread-cleared" | "thread-switched";
  source?: "manual" | "auto-hydration" | "auto-backfill";
  cycleId?: number | null;
  requestId?: string | null;
  launchKey?: string | null;
};

export type AutoBackfillStopReason =
  | "abort"
  | "loading-older-history"
  | "no-more-events"
  | "no-result"
  | "empty-cursors"
  | "completion-reason"
  | "no-progress"
  | "timeline-complete"
  | "semantic-boundary-detected"
  | "max-pages";

export type AutoBackfillLoopOutcome = {
  pagesLoaded: number;
  stopReason: AutoBackfillStopReason;
  semanticBoundary: SemanticBoundary | null;
};

export type AutoBackfillLoopInput = {
  maxPages: number;
  shouldAbort: () => boolean;
  isLoadingOlderHistory: () => boolean;
  getBeforeIdx: () => number | null;
  loadOlderHistoryPage: (pageNumber: number) => Promise<LoadOlderHistoryResult | void>;
  isTimelineIncomplete: () => boolean;
  isAutoBackfillAllowed?: () => boolean;
  stopOnSemanticBoundary?: boolean;
};

export type HydrationBackfillPolicy = "manual" | "auto";

export type SnapshotSeedDecision = {
  shouldApply: boolean;
  reason: "thread-changed" | "no-thread-or-snapshot" | "same-snapshot-key" | "snapshot-key-changed";
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
  hydrationBackfillPolicy?: HydrationBackfillPolicy;
}
