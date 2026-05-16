import type {
  AgentTodoItem,
  ChatEvent,
  ChatTimelineActivityStep as ActivityTraceStep,
  CliAgent,
  ChatTimelineExploreActivityEntry as ExploreActivityEntry,
} from "@codesymphony/shared-types";

export type TimelineTodoStatus = AgentTodoItem["status"] | "cancelled";

export type TimelineTodoItem = Omit<AgentTodoItem, "status"> & {
  status: TimelineTodoStatus;
};

export type StepCandidate = {
  key: string | null;
  priority: number;
  idx: number;
  step: ActivityTraceStep;
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

export type GenericToolRun = {
  id: string;
  toolUseId: string;
  startIdx: number;
  anchorIdx: number;
  toolName: string | null;
  summary: string | null;
  output: string | null;
  error: string | null;
  truncated: boolean;
  durationSeconds: number | null;
  status: "running" | "success" | "failed";
  createdAt: string;
  eventIds: Set<string>;
  sourceEvents: ChatEvent[];
  event: ChatEvent | null;
};

export type EditedRun = {
  id: string;
  eventId: string;
  startIdx: number;
  anchorIdx: number;
  endIdx: number;
  changeSource: "edit-tool" | "worktree-diff";
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
  endIdx: number;
  anchorIdx: number;
  createdAt: string;
  eventIds: Set<string>;
};

export type SubagentStep = {
  toolUseId: string;
  toolName: string;
  label: string;
  openPath: string | null;
  status: "running" | "success" | "failed";
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

export type AskUserQuestionGroup = {
  id: string;
  toolUseId: string;
  status: "running" | "success" | "failed";
  summary: string;
  startIdx: number;
  anchorIdx: number;
  createdAt: string;
  eventIds: Set<string>;
  sourceEvents: ChatEvent[];
};

export type TodoListGroup = {
  id: string;
  groupId: string;
  agent: CliAgent;
  explanation: string | null;
  status: "running" | "completed";
  items: TimelineTodoItem[];
  startIdx: number;
  anchorIdx: number;
  createdAt: string;
  eventIds: Set<string>;
};

export type TodoProgressGroup = {
  id: string;
  groupId: string;
  agent: CliAgent;
  todoId: string | null;
  content: string;
  startIdx: number;
  anchorIdx: number;
  createdAt: string;
  eventIds: Set<string>;
};

type PendingPermissionRequest = {
  requestId: string;
  toolName: string;
  command: string | null;
  editTarget: string | null;
  blockedPath: string | null;
  decisionReason: string | null;
  idx: number;
};

type QuestionOption = {
  label: string;
  description?: string;
};

type QuestionItem = {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
};

type PendingQuestionRequest = {
  requestId: string;
  questions: QuestionItem[];
  idx: number;
};

type PendingPlan = {
  content: string;
  filePath: string;
  createdIdx: number;
  status: "pending" | "revising" | "sending" | "approved" | "superseded";
};
