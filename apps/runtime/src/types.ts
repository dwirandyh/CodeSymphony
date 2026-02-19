import type { PrismaClient } from "@prisma/client";
import type { ChatEvent, ChatEventType, ChatMode, PermissionDecision } from "@codesymphony/shared-types";

export type RuntimeEventPayload = Record<string, unknown>;

export type RuntimeEventHub = {
  emit: (threadId: string, type: ChatEventType, payload: RuntimeEventPayload) => Promise<ChatEvent>;
  list: (threadId: string, afterIdx?: number) => Promise<ChatEvent[]>;
  subscribe: (threadId: string, listener: (event: ChatEvent) => void) => () => void;
};

export type ClaudeRunnerResult = {
  output: string;
  sessionId: string | null;
};

export type PlanDetectionSource = "claude_plan_file" | "streaming_fallback";

export type ClaudeToolInstrumentationStage = "requested" | "decision" | "started" | "finished" | "failed" | "anomaly";

export type ClaudeToolInstrumentationDecision = "allow" | "deny" | "auto_allow" | "plan_deny";

export type ClaudeToolInstrumentationAnomalyCode =
  | "requested_not_started"
  | "started_not_finished"
  | "summary_unknown_tool";

export type ClaudeToolInstrumentationEvent = {
  stage: ClaudeToolInstrumentationStage;
  toolUseId: string;
  toolName: string;
  parentToolUseId: string | null;
  decision?: ClaudeToolInstrumentationDecision;
  summary?: string;
  threadContext?: {
    cwd: string;
    sessionId: string | null;
    permissionMode: ChatMode | "default";
    autoAcceptTools: boolean;
  };
  timing?: {
    progressCount?: number;
    maxElapsedTimeSeconds?: number;
    elapsedTimeSeconds?: number;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
  };
  preview?: {
    command?: string;
    startSource?: "sdk.hook.pre_tool_use" | "sdk.stream.tool_progress";
    input?: unknown;
    output?: string;
    error?: string;
    truncated?: boolean;
    outputBytes?: number;
    blockedPath?: string | null;
    decisionReason?: string | null;
    suggestionsCount?: number;
  };
  anomaly?: {
    code: ClaudeToolInstrumentationAnomalyCode;
    message: string;
    relatedToolUseIds?: string[];
  };
};

export type ClaudeRunner = (args: {
  prompt: string;
  sessionId: string | null;
  cwd: string;
  abortController?: AbortController;
  permissionMode?: ChatMode;
  autoAcceptTools?: boolean;
  onText: (chunk: string) => Promise<void> | void;
  onToolStarted: (payload: {
    toolName: string;
    toolUseId: string;
    parentToolUseId: string | null;
    command?: string;
    searchParams?: string;
    editTarget?: string;
    shell?: "bash";
    isBash?: true;
  }) => Promise<void> | void;
  onToolOutput: (payload: {
    toolName: string;
    toolUseId: string;
    parentToolUseId: string | null;
    elapsedTimeSeconds: number;
  }) => Promise<void> | void;
  onToolFinished: (payload: {
    summary: string;
    precedingToolUseIds: string[];
    command?: string;
    searchParams?: string;
    editTarget?: string;
    output?: string;
    error?: string;
    shell?: "bash";
    isBash?: true;
    truncated?: boolean;
    outputBytes?: number;
  }) => Promise<void> | void;
  onQuestionRequest: (payload: {
    requestId: string;
    questions: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  }) => Promise<{ answers: Record<string, string> }>;
  onPermissionRequest: (payload: {
    requestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    blockedPath: string | null;
    decisionReason: string | null;
    suggestions: unknown[] | null;
  }) => Promise<{ decision: PermissionDecision; message?: string }> | { decision: PermissionDecision; message?: string };
  onPlanFileDetected: (payload: {
    filePath: string;
    content: string;
    source?: PlanDetectionSource;
  }) => Promise<void> | void;
  onSubagentStarted: (payload: {
    agentId: string;
    agentType: string;
    toolUseId: string;
    description: string;
  }) => Promise<void> | void;
  onSubagentStopped: (payload: {
    agentId: string;
    agentType: string;
    toolUseId: string;
    description: string;
    lastMessage: string;
  }) => Promise<void> | void;
  onToolInstrumentation?: (event: ClaudeToolInstrumentationEvent) => Promise<void> | void;
}) => Promise<ClaudeRunnerResult>;

export type RuntimeDeps = {
  prisma: PrismaClient;
  eventHub: RuntimeEventHub;
  claudeRunner: ClaudeRunner;
  logService?: {
    log: (level: "debug" | "info" | "warn" | "error", source: string, message: string, data?: unknown) => void;
  };
};
