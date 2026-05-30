import type { CliAgent, ModelProviderCompatibility } from "@codesymphony/shared-types";
import type { ClaudeOwnershipReason } from "../../types.js";

export type WorktreeStateSnapshot = {
  statusOutput: string;
  unstagedDiff: string;
  stagedDiff: string;
  changedFiles: string[];
  untrackedFileSignatures: Map<string, string>;
  untrackedFileContents: Map<string, string>;
};

export type WorktreeDiffDelta = {
  changedFiles: string[];
  fullDiff: string;
  diff: string;
  diffTruncated: boolean;
};

export type WorktreeMutationTracker = {
  sawMutatingTool: boolean;
  sawBashTool: boolean;
  ownedPaths: Set<string>;
};

export type ActiveModelProvider = {
  id: string;
  compatibility: ModelProviderCompatibility;
  apiKey: string | null;
  baseUrl: string | null;
  name: string;
  modelId: string;
};

export type ProviderOptions = {
  agent?: CliAgent;
  model?: string;
  providerCompatibility?: ModelProviderCompatibility;
  providerApiKey?: string;
  providerBaseUrl?: string;
};

export type ParsedDiffSections = {
  byFile: Map<string, string>;
  order: string[];
};

export type PermissionDecisionResult = { decision: "allow" | "allow_always" | "deny"; message?: string };
export type AlwaysAllowScope = "session" | "workspace" | "native";
export type PendingPermissionEntry = {
  status: "pending" | "resolved";
  promise: Promise<PermissionDecisionResult>;
  resolve?: (result: PermissionDecisionResult) => void;
  reject?: (error: Error) => void;
  result?: PermissionDecisionResult;
  assistantMessageId: string | null;
  toolName: string;
  command: string | null;
  canAlwaysAllow: boolean;
  alwaysAllowScope: AlwaysAllowScope | null;
  alwaysAllowDescription: string | null;
  permissionSignatures: string[];
  subagentOwnerToolUseId: string | null;
  launcherToolUseId: string | null;
  ownershipReason: ClaudeOwnershipReason | null;
  ownershipCandidates: string[];
  activeSubagentToolUseIds: string[];
};

export type QuestionAnswerResult = { answers: Record<string, string> };
export type PendingQuestionEntry = {
  status: "pending" | "resolved";
  promise: Promise<QuestionAnswerResult>;
  resolve?: (result: QuestionAnswerResult) => void;
  reject?: (error: Error) => void;
  assistantMessageId: string | null;
};

export type PendingPlanEntry = {
  eventId: string;
  content: string;
  filePath: string;
};
