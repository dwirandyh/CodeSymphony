import type { PrismaClient } from "@prisma/client";
import type { RunEvent, RunEventType } from "@codesymphony/shared-types";

export type RuntimeEventPayload = Record<string, unknown>;

export type RuntimeEventHub = {
  emit: (runId: string, type: RunEventType, payload: RuntimeEventPayload) => Promise<RunEvent>;
  list: (runId: string, afterIdx?: number) => Promise<RunEvent[]>;
  subscribe: (runId: string, listener: (event: RunEvent) => void) => () => void;
};

export type PromptStepResult = {
  output: string;
  sessionId: string | null;
};

export type PromptStepRunner = (args: {
  prompt: string;
  sessionId: string | null;
  onLog: (chunk: string) => Promise<void> | void;
}) => Promise<PromptStepResult>;

export type RuntimeDeps = {
  prisma: PrismaClient;
  eventHub: RuntimeEventHub;
  promptStepRunner: PromptStepRunner;
};
