import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  type AvailableCommand,
  type CreateElicitationResponse,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

type FakeCursorModel = {
  modelId: string;
  name: string;
};

type FakeCursorMode = {
  id: string;
  name: string;
};

type FakeCursorSessionState = {
  sessionId: string;
  currentModeId: string;
  currentModelId: string;
  prompts: string[];
  promptBlocks: unknown[];
  abortController: AbortController | null;
};

export type FakeCursorScenario = {
  availableCommands?: AvailableCommand[];
  availableModels?: FakeCursorModel[];
  availableModes?: FakeCursorMode[];
  promptCapabilities?: {
    image?: boolean;
  };
  onPrompt?: (params: {
    agent: FakeCursorAgent;
    sessionId: string;
    promptText: string;
    abortSignal: AbortSignal;
  }) => Promise<{ stopReason?: "end_turn" | "cancelled" } | void>;
};

const DEFAULT_MODES = [
  { id: "ask", name: "Ask" },
  { id: "agent", name: "Agent" },
  { id: "plan", name: "Plan" },
];

const DEFAULT_MODELS: FakeCursorModel[] = [
  { modelId: "default[]", name: "Auto" },
];

let sessionCounter = 0;

export const fakeCursorSessions = new Map<string, FakeCursorSessionState>();

function nextSessionId(): string {
  sessionCounter += 1;
  return `cursor-session-${sessionCounter}`;
}

function readPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) {
    return "";
  }

  return prompt
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const item = entry as { type?: string; text?: string };
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n");
}

function buildModelState(models: FakeCursorModel[], currentModelId: string) {
  return {
    availableModels: models.map((model) => ({
      modelId: model.modelId,
      name: model.name,
    })),
    currentModelId,
  };
}

function buildModeState(currentModeId: string, modes: FakeCursorMode[]) {
  return {
    availableModes: modes,
    currentModeId,
  };
}

function queueAvailableCommands(
  connection: AgentSideConnection,
  sessionId: string,
  availableCommands: AvailableCommand[],
): void {
  queueMicrotask(() => {
    void connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands,
      },
    });
  });
}

export class MockCursorChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;

  kill(signal?: string): boolean {
    if (this.killed) {
      return true;
    }

    this.killed = true;
    this.exitCode = 0;
    queueMicrotask(() => {
      this.emit("exit", this.exitCode, signal ?? null);
    });
    return true;
  }
}

export class FakeCursorAgent {
  constructor(
    private readonly connection: AgentSideConnection,
    private readonly scenario: FakeCursorScenario,
  ) {}

  async initialize() {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        ...(this.scenario.promptCapabilities ? { promptCapabilities: this.scenario.promptCapabilities } : {}),
      },
    };
  }

  async authenticate() {
    return {};
  }

  async newSession() {
    const sessionId = nextSessionId();
    const models = this.scenario.availableModels ?? DEFAULT_MODELS;
    const modes = this.scenario.availableModes ?? DEFAULT_MODES;
    const currentModelId = models[0]?.modelId ?? DEFAULT_MODELS[0]!.modelId;
    const currentModeId = modes[0]?.id ?? DEFAULT_MODES[0]!.id;
    fakeCursorSessions.set(sessionId, {
      sessionId,
      currentModeId,
      currentModelId,
      prompts: [],
      promptBlocks: [],
      abortController: null,
    });

    queueAvailableCommands(this.connection, sessionId, this.scenario.availableCommands ?? []);

    return {
      sessionId,
      modes: buildModeState(currentModeId, modes),
      models: buildModelState(models, currentModelId),
    };
  }

  async loadSession(params: { sessionId: string }) {
    const state = fakeCursorSessions.get(params.sessionId);
    if (!state) {
      throw new Error(`Unknown fake Cursor session ${params.sessionId}`);
    }

    const modes = this.scenario.availableModes ?? DEFAULT_MODES;

    queueAvailableCommands(this.connection, params.sessionId, this.scenario.availableCommands ?? []);

    return {
      modes: buildModeState(state.currentModeId, modes),
      models: buildModelState(this.scenario.availableModels ?? DEFAULT_MODELS, state.currentModelId),
    };
  }

  async setSessionMode(params: { sessionId: string; modeId: string }) {
    const state = fakeCursorSessions.get(params.sessionId);
    if (state) {
      state.currentModeId = params.modeId;
    }
    return {};
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }) {
    const state = fakeCursorSessions.get(params.sessionId);
    if (state) {
      state.currentModelId = params.modelId;
    }
    return {};
  }

  async prompt(params: { sessionId: string; prompt: unknown }) {
    const state = fakeCursorSessions.get(params.sessionId);
    if (!state) {
      throw new Error(`Unknown fake Cursor session ${params.sessionId}`);
    }

    const abortController = new AbortController();
    state.abortController = abortController;
    state.prompts.push(readPromptText(params.prompt));
    state.promptBlocks.push(params.prompt);

    try {
      const result = await this.scenario.onPrompt?.({
        agent: this,
        sessionId: params.sessionId,
        promptText: state.prompts.at(-1) ?? "",
        abortSignal: abortController.signal,
      });

      if (abortController.signal.aborted || result?.stopReason === "cancelled") {
        return {
          stopReason: "cancelled" as const,
        };
      }

      return {
        stopReason: result?.stopReason ?? "end_turn",
      };
    } finally {
      state.abortController = null;
    }
  }

  async cancel(params: { sessionId: string }) {
    fakeCursorSessions.get(params.sessionId)?.abortController?.abort();
  }

  async emitText(sessionId: string, text: string) {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text,
        },
      },
    });
  }

  async emitToolCall(
    sessionId: string,
    update: {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind: string;
      status: string;
      locations?: Array<{ path?: string }>;
      rawInput?: Record<string, unknown>;
      content?: unknown[];
    },
  ) {
    await this.connection.sessionUpdate({
      sessionId,
      update,
    });
  }

  async emitToolCallUpdate(
    sessionId: string,
    update: {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status: string;
      title?: string;
      kind?: string;
      locations?: Array<{ path?: string }>;
      rawInput?: Record<string, unknown>;
      rawOutput?: Record<string, unknown>;
      content?: unknown[];
    },
  ) {
    await this.connection.sessionUpdate({
      sessionId,
      update,
    });
  }

  async emitPlan(sessionId: string, entries: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>) {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "plan",
        entries: entries.map((entry) => ({
          ...entry,
          priority: "medium" as const,
        })),
      },
    });
  }

  async createPlan(name: string, plan: string) {
    await this.connection.extMethod("cursor/create_plan", {
      name,
      plan,
    });
  }

  async createFormElicitation(params: {
    sessionId: string;
    message: string;
    toolCallId?: string;
    requestedSchema: {
      title?: string;
      description?: string;
      required?: string[];
      properties: Record<string, unknown>;
    };
  }): Promise<CreateElicitationResponse> {
    return await this.connection.unstable_createElicitation({
      mode: "form",
      sessionId: params.sessionId,
      ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
      message: params.message,
      requestedSchema: {
        type: "object",
        title: params.requestedSchema.title,
        description: params.requestedSchema.description,
        required: params.requestedSchema.required,
        properties: params.requestedSchema.properties,
      },
    });
  }

  async requestPermission(params: {
    sessionId: string;
    toolCall: ToolCall;
    options: Array<{
      kind: "allow_once" | "allow_always" | "reject_once";
      name: string;
      optionId: string;
    }>;
  }): Promise<RequestPermissionResponse> {
    return await this.connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: params.toolCall,
      options: params.options,
    });
  }
}

export function createMockCursorChild(scenario: FakeCursorScenario = {}): MockCursorChild {
  const child = new MockCursorChild();
  const stream = ndJsonStream(
    Writable.toWeb(child.stdout as Writable) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdin as Readable) as unknown as ReadableStream<Uint8Array>,
  );
  new AgentSideConnection((connection) => new FakeCursorAgent(connection, scenario), stream);
  return child;
}

export function resetFakeCursorAcpState(): void {
  sessionCounter = 0;
  fakeCursorSessions.clear();
}
