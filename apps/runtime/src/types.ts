import type { PrismaClient } from "@prisma/client";
import type { ChatEvent, ChatEventType } from "@codesymphony/shared-types";

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

export type ClaudeRunner = (args: {
  prompt: string;
  sessionId: string | null;
  cwd: string;
  onText: (chunk: string) => Promise<void> | void;
  onToolStarted: (payload: { toolName: string; toolUseId: string; parentToolUseId: string | null }) => Promise<void> | void;
  onToolOutput: (payload: {
    toolName: string;
    toolUseId: string;
    parentToolUseId: string | null;
    elapsedTimeSeconds: number;
  }) => Promise<void> | void;
  onToolFinished: (payload: { summary: string; precedingToolUseIds: string[] }) => Promise<void> | void;
}) => Promise<ClaudeRunnerResult>;

export type RuntimeDeps = {
  prisma: PrismaClient;
  eventHub: RuntimeEventHub;
  claudeRunner: ClaudeRunner;
};
