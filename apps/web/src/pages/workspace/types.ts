import type { ExploreActivityEntry } from "../../components/workspace/ChatMessageList";

export type StepCandidate = {
  key: string | null;
  priority: number;
  idx: number;
  step: import("../../components/workspace/ChatMessageList").ActivityTraceStep;
};

export type BashRun = {
  id: string;
  toolUseId: string;
  startIdx: number;
  anchorIdx: number;
  summary: string | null;
  command: string | null;
  output: string | null;
  error: string | null;
  truncated: boolean;
  durationSeconds: number | null;
  status: "running" | "success" | "failed";
  rejectedByUser: boolean;
  createdAt: string;
  eventIds: Set<string>;
};

export type EditedRun = {
  id: string;
  eventId: string;
  startIdx: number;
  anchorIdx: number;
  status: "running" | "success" | "failed";
  diffKind: "proposed" | "actual" | "none";
  changedFiles: string[];
  diff: string;
  diffTruncated: boolean;
  additions: number;
  deletions: number;
  rejectedByUser: boolean;
  createdAt: string;
  eventIds: Set<string>;
};

export type ExploreRunKind = "read" | "search";

export type ExploreRunState = {
  id: string;
  kind: ExploreRunKind;
  pending: boolean;
  label: string;
  openPath: string | null;
  searchToolName: string | null;
  searchParams: string | null;
  orderIdx: number;
  startIdx: number;
  createdAt: string;
  eventIds: Set<string>;
};

export type ExploreActivityGroup = {
  id: string;
  status: "running" | "success";
  fileCount: number;
  searchCount: number;
  entries: ExploreActivityEntry[];
  startIdx: number;
  anchorIdx: number;
  createdAt: string;
  eventIds: Set<string>;
};

export type SubagentStep = {
  toolUseId: string;
  toolName: string;
  label: string;
  openPath: string | null;
  status: "running" | "success";
};

export type SubagentGroup = {
  id: string;
  agentId: string;
  agentType: string;
  toolUseId: string;
  status: "running" | "success";
  description: string;
  lastMessage: string | null;
  steps: SubagentStep[];
  durationSeconds: number | null;
  startIdx: number;
  anchorIdx: number;
  createdAt: string;
  eventIds: Set<string>;
};

export type PendingPermissionRequest = {
  requestId: string;
  toolName: string;
  command: string | null;
  editTarget: string | null;
  blockedPath: string | null;
  decisionReason: string | null;
  idx: number;
};

export type QuestionOption = {
  label: string;
  description?: string;
};

export type QuestionItem = {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
};

export type PendingQuestionRequest = {
  requestId: string;
  questions: QuestionItem[];
  idx: number;
};

export type PendingPlan = {
  content: string;
  filePath: string;
  createdIdx: number;
  status: "pending" | "revising" | "sending" | "approved" | "superseded";
};
