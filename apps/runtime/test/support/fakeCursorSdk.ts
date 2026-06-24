import type {
  AgentOptions,
  CursorRequestOptions,
  ModelSelection,
  SDKAgent,
  SDKMessage,
  SDKModel,
  SDKUserMessage,
  SendOptions,
  Run,
  RunOperation,
  RunResult,
  RunStatus,
} from "@cursor/sdk";

export type FakeCursorSdkScenario = {
  models?: SDKModel[];
  agentId?: string;
  onSend?: (params: {
    agent: FakeCursorSdkAgent;
    message: string | SDKUserMessage;
    options?: SendOptions;
    run: FakeCursorSdkRun;
  }) => Promise<void> | void;
};

export type FakeCursorSdkAgentState = {
  agentId: string;
  createOptions?: AgentOptions;
  resumeOptions?: Partial<AgentOptions>;
  sends: Array<{
    message: string | SDKUserMessage;
    options?: SendOptions;
  }>;
  closed: boolean;
};

let agentCounter = 0;
let runCounter = 0;
let scenario: FakeCursorSdkScenario = {};

export const fakeCursorSdkAgents = new Map<string, FakeCursorSdkAgentState>();
export const fakeCursorSdkCreateRequests: AgentOptions[] = [];
export const fakeCursorSdkResumeRequests: Array<{ agentId: string; options?: Partial<AgentOptions> }> = [];
export const fakeCursorSdkModelListRequests: CursorRequestOptions[] = [];
export const fakeCursorSdkRuns: FakeCursorSdkRun[] = [];

function nextAgentId(): string {
  agentCounter += 1;
  return `agent-${agentCounter}`;
}

function nextRunId(): string {
  runCounter += 1;
  return `run-${runCounter}`;
}

export function configureFakeCursorSdk(nextScenario: FakeCursorSdkScenario = {}): void {
  scenario = nextScenario;
}

export function resetFakeCursorSdkState(): void {
  agentCounter = 0;
  runCounter = 0;
  scenario = {};
  fakeCursorSdkAgents.clear();
  fakeCursorSdkCreateRequests.length = 0;
  fakeCursorSdkResumeRequests.length = 0;
  fakeCursorSdkModelListRequests.length = 0;
  fakeCursorSdkRuns.length = 0;
}

export class FakeCursorSdkRun implements Run {
  readonly id = nextRunId();
  readonly requestId = `request-${this.id}`;
  status: RunStatus = "running";
  result?: string;
  model?: ModelSelection;
  durationMs?: number;
  git = undefined;
  private readonly messages: SDKMessage[] = [];
  private readonly listeners = new Set<(status: RunStatus) => void>();
  private cancelled = false;

  constructor(readonly agentId: string) {}

  supports(operation: RunOperation): boolean {
    return operation === "stream" || operation === "wait" || operation === "cancel" || operation === "conversation";
  }

  unsupportedReason(operation: RunOperation): string | undefined {
    return this.supports(operation) ? undefined : `Unsupported fake operation ${operation}`;
  }

  push(message: SDKMessage): void {
    this.messages.push(message);
  }

  finish(result = ""): void {
    this.result = result;
    this.setStatus("finished");
  }

  error(result = ""): void {
    this.result = result;
    this.setStatus("error");
  }

  async *stream(): AsyncGenerator<SDKMessage, void> {
    for (const message of this.messages) {
      if (this.cancelled) {
        return;
      }
      yield message;
    }
  }

  async conversation(): Promise<never[]> {
    return [];
  }

  async wait(): Promise<RunResult> {
    if (this.status === "running") {
      this.finish(this.result ?? "");
    }

    return {
      id: this.id,
      requestId: this.requestId,
      status: this.status === "running" ? "error" : this.status,
      ...(this.result !== undefined ? { result: this.result } : {}),
      ...(this.model ? { model: this.model } : {}),
    };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.setStatus("cancelled");
  }

  onDidChangeStatus(listener: (status: RunStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: RunStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}

export class FakeCursorSdkAgent implements SDKAgent {
  model: ModelSelection | undefined;

  constructor(readonly agentId: string) {}

  async send(message: string | SDKUserMessage, options?: SendOptions): Promise<Run> {
    if (listNonTerminalFakeRuns(this.agentId).length > 0) {
      throw new Error(`Agent ${this.agentId} already has active run`);
    }

    fakeCursorSdkAgents.get(this.agentId)?.sends.push({ message, options });
    const run = new FakeCursorSdkRun(this.agentId);
    run.model = options?.model ?? this.model;
    fakeCursorSdkRuns.push(run);
    await scenario.onSend?.({ agent: this, message, options, run });
    return run;
  }

  close(): void {
    const state = fakeCursorSdkAgents.get(this.agentId);
    if (state) {
      state.closed = true;
    }
  }

  async reload(): Promise<void> {}

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  async listArtifacts(): Promise<never[]> {
    return [];
  }

  async downloadArtifact(): Promise<Buffer> {
    return Buffer.from("");
  }
}

function listNonTerminalFakeRuns(agentId: string): FakeCursorSdkRun[] {
  return fakeCursorSdkRuns.filter((run) => (
    run.agentId === agentId
    && run.status !== "finished"
    && run.status !== "error"
    && run.status !== "cancelled"
  ));
}

export const FakeCursorSdkModule = {
  Agent: {
    listRuns: async (agentId: string) => ({
      items: fakeCursorSdkRuns
        .filter((run) => run.agentId === agentId)
        .map((run) => ({
          id: run.id,
          status: run.status,
        })),
    }),
    cancelRun: async (runId: string) => {
      const run = fakeCursorSdkRuns.find((entry) => entry.id === runId);
      await run?.cancel();
    },
    getRun: async (runId: string) => {
      const run = fakeCursorSdkRuns.find((entry) => entry.id === runId);
      if (!run) {
        throw new Error(`Unknown fake run ${runId}`);
      }
      return run;
    },
    create: async (options: AgentOptions): Promise<SDKAgent> => {
      fakeCursorSdkCreateRequests.push(options);
      const agentId = scenario.agentId ?? options.agentId ?? nextAgentId();
      fakeCursorSdkAgents.set(agentId, {
        agentId,
        createOptions: options,
        sends: [],
        closed: false,
      });
      return new FakeCursorSdkAgent(agentId);
    },
    resume: async (agentId: string, options?: Partial<AgentOptions>): Promise<SDKAgent> => {
      fakeCursorSdkResumeRequests.push({ agentId, options });
      fakeCursorSdkAgents.set(agentId, {
        agentId,
        resumeOptions: options,
        sends: [],
        closed: false,
      });
      return new FakeCursorSdkAgent(agentId);
    },
  },
  Cursor: {
    models: {
      list: async (options?: CursorRequestOptions): Promise<SDKModel[]> => {
        fakeCursorSdkModelListRequests.push(options ?? {});
        return scenario.models ?? [];
      },
    },
  },
};
