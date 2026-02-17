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
}) => Promise<ClaudeRunnerResult>;

export type RuntimeDeps = {
  prisma: PrismaClient;
  eventHub: RuntimeEventHub;
  claudeRunner: ClaudeRunner;
};
