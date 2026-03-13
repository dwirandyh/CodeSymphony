import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ChatAttachment, ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import type { SubagentStep } from "../../../pages/workspace/types";

export type AssistantRenderHint = "markdown" | "raw-file" | "raw-fallback" | "diff";

export type ReadFileTimelineEntry = {
  label: string;
  openPath: string | null;
};

export type ExploreActivityEntry = {
  kind: "read" | "search";
  label: string;
  openPath: string | null;
  pending: boolean;
  orderIdx: number;
};

export type ActivityTraceStep = {
  id: string;
  label: string;
  detail: string;
};

export type ChatTimelineItem =
  | {
    kind: "message";
    message: ChatMessage;
    renderHint?: AssistantRenderHint;
    rawFileLanguage?: string;
    isCompleted?: boolean;
    context?: ChatEvent[];
  }
  | {
    kind: "plan-file-output";
    id: string;
    messageId: string;
    content: string;
    filePath: string;
    createdAt: string;
  }
  | {
    kind: "activity";
    messageId: string;
    durationSeconds: number;
    introText: string | null;
    steps: ActivityTraceStep[];
    defaultExpanded: boolean;
  }
  | {
    kind: "tool";
    id: string;
    event: ChatEvent | null;
    sourceEvents?: ChatEvent[];
    toolUseId?: string;
    toolName?: string | null;
    shell?: "bash";
    command?: string | null;
    summary?: string | null;
    output?: string | null;
    error?: string | null;
    truncated?: boolean;
    durationSeconds?: number | null;
    status?: "running" | "success" | "failed";
    rejectedByUser?: boolean;
  }
  | {
    kind: "edited-diff";
    id: string;
    eventId: string;
    status: "running" | "success" | "failed";
    diffKind: "proposed" | "actual" | "none";
    changedFiles: string[];
    diff: string;
    diffTruncated: boolean;
    additions: number;
    deletions: number;
    rejectedByUser?: boolean;
    createdAt: string;
  }
  | {
    kind: "explore-activity";
    id: string;
    status: "running" | "success";
    fileCount: number;
    searchCount: number;
    entries: ExploreActivityEntry[];
  }
  | {
    kind: "subagent-activity";
    id: string;
    agentId: string;
    agentType: string;
    toolUseId: string;
    status: "running" | "success" | "failed";
    description: string;
    lastMessage: string | null;
    steps: SubagentStep[];
    durationSeconds: number | null;
  }
  | {
    kind: "thinking";
    id: string;
    messageId: string;
    content: string;
    isStreaming: boolean;
  }
  | {
    kind: "error";
    id: string;
    message: string;
    createdAt: string;
  };

export type ChatTimelineSummary = {
  oldestRenderableKey: string | null;
  oldestRenderableKind: ChatTimelineItem["kind"] | null;
  oldestRenderableMessageId: string | null;
  oldestRenderableHydrationPending: boolean;
  headIdentityStable: boolean;
};

export type ChatMessageListProps = {
  items: ChatTimelineItem[];
  showThinkingPlaceholder?: boolean;
  onOpenReadFile?: (path: string) => void | Promise<void>;
};

export type AnsiSegment = {
  text: string;
  fgColor: string | null;
  bold: boolean;
  dim: boolean;
};

export type AnsiStyleState = {
  fgColor: string | null;
  bold: boolean;
  dim: boolean;
};

export type TimelineCtx = {
  rawOutputMessageIds: Set<string>;
  copiedMessageId: string | null;
  copiedDebug: boolean;
  renderDebugEnabled: boolean;
  toggleRawOutput: (id: string) => void;
  copyOutput: (id: string, content: string) => void;
  copyDebugLog: () => void;
  onOpenReadFile?: (path: string) => void | Promise<void>;
  toolExpandedById: Map<string, boolean>;
  setToolExpandedById: Dispatch<SetStateAction<Map<string, boolean>>>;
  editedExpandedById: Map<string, boolean>;
  setEditedExpandedById: Dispatch<SetStateAction<Map<string, boolean>>>;
  exploreActivityExpandedById: Map<string, boolean>;
  setExploreActivityExpandedById: Dispatch<SetStateAction<Map<string, boolean>>>;
  subagentExpandedById: Map<string, boolean>;
  setSubagentExpandedById: Dispatch<SetStateAction<Map<string, boolean>>>;
  subagentPromptExpandedById: Map<string, boolean>;
  setSubagentPromptExpandedById: Dispatch<SetStateAction<Map<string, boolean>>>;
  subagentExploreExpandedById: Map<string, boolean>;
  setSubagentExploreExpandedById: Dispatch<SetStateAction<Map<string, boolean>>>;
  lastRenderSignatureByMessageIdRef: MutableRefObject<Map<string, string>>;
};
