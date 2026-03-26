import type { AskUserQuestionItem, AskUserQuestionResult, ClaudeOwnershipReason } from "../../types.js";

export type WorktreeStateSnapshot = {
  statusOutput: string;
  unstagedDiff: string;
  stagedDiff: string;
  changedFiles: string[];
};

export type ActiveModelProvider = {
  apiKey: string;
  baseUrl: string;
  name: string;
  modelId: string;
};

export type ProviderOptions = {
  model?: string;
  providerApiKey?: string;
  providerBaseUrl?: string;
};

export type ParsedDiffSections = {
  byFile: Map<string, string>;
  order: string[];
};

export type PermissionDecisionResult = { decision: "allow" | "deny"; message?: string };
export type PendingPermissionEntry = {
  status: "pending" | "resolved";
  promise: Promise<PermissionDecisionResult>;
  resolve?: (result: PermissionDecisionResult) => void;
  reject?: (error: Error) => void;
  result?: PermissionDecisionResult;
  toolName: string;
  command: string | null;
  subagentOwnerToolUseId: string | null;
  launcherToolUseId: string | null;
  ownershipReason: ClaudeOwnershipReason | null;
  ownershipCandidates: string[];
  activeSubagentToolUseIds: string[];
};

export type QuestionAnswerResult = AskUserQuestionResult;
export type PendingQuestionEntry = {
  status: "pending" | "resolved";
  promise: Promise<QuestionAnswerResult>;
  resolve?: (result: QuestionAnswerResult) => void;
  reject?: (error: Error) => void;
  questions: AskUserQuestionItem[];
};

export type PendingPlanEntry = {
  content: string;
  filePath: string;
};
