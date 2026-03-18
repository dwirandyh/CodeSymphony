import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import type { ChatTimelineItem } from "../../../../components/workspace/chat-message-list/ChatMessageList.types";
import type { BashRun, EditedRun, ExploreActivityGroup, SubagentGroup } from "../../types";

export type TimelineRefs = {
  streamingMessageIds: Set<string>;
  stickyRawFallbackMessageIds: Set<string>;
  renderDecisionByMessageId: Map<string, string>;
  loggedOrphanEventIdsByThread: Map<string, Set<string>>;
  claimedContextEventIdsByThreadMessage?: Map<string, Set<string>>;
};

export type WorkspaceTimelineResult = {
  items: ChatTimelineItem[];
  hasIncompleteCoverage: boolean;
  summary: {
    oldestRenderableKey: string | null;
    oldestRenderableKind: ChatTimelineItem["kind"] | null;
    oldestRenderableMessageId: string | null;
    oldestRenderableHydrationPending: boolean;
    headIdentityStable: boolean;
  };
};

export type UseWorkspaceTimelineOptions = {
  semanticHydrationInProgress?: boolean;
  disabled?: boolean;
};

export type ThinkingRound = {
  content: string;
  firstIdx: number;
  lastIdx: number;
};

export type SortableEntry = {
  item: ChatTimelineItem;
  anchorIdx: number;
  timestamp: number | null;
  rank: number;
  stableOrder: number;
};

export type InlineInsert =
  | {
    kind: "bash";
    id: string;
    startIdx: number;
    anchorIdx: number;
    createdAt: string;
    run: BashRun;
  }
  | {
    kind: "edited";
    id: string;
    startIdx: number;
    anchorIdx: number;
    createdAt: string;
    run: EditedRun;
  }
  | {
    kind: "subagent-activity";
    id: string;
    startIdx: number;
    anchorIdx: number;
    createdAt: string;
    group: SubagentGroup;
  }
  | {
    kind: "explore-activity";
    id: string;
    startIdx: number;
    anchorIdx: number;
    createdAt: string;
    group: ExploreActivityGroup;
  }
  | {
    kind: "plan-file-output";
    id: string;
    startIdx: number;
    anchorIdx: number;
    createdAt: string;
    planFileOutput: { id: string; messageId: string; content: string; filePath: string; idx: number; createdAt: string };
  };

export type PlanFileOutput = {
  id: string;
  messageId: string;
  content: string;
  filePath: string;
  idx: number;
  createdAt: string;
};

export type SegmentBucket = {
  content: string;
  anchorIdx: number | null;
  timestamp: number | null;
};
