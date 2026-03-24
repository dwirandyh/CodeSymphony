import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  PromptResponse,
  PromptRequest,
  AuthenticateRequest,
  AuthenticateResponse,
} from "@agentclientprotocol/sdk";
import type { AgentRunner, ClaudeOwnershipReason } from "../types.js";
import { extractBashToolResult } from "./bashResult.js";
import { extractSubagentResponse } from "./subagentTranscript.js";
import {
  DEFAULT_CLAUDE_EXECUTABLE,
  buildExecutableCandidates,
  selectExecutableForCurrentProcess,
  withClaudeSetupHint,
} from "./executableResolver.js";
import {
  commandFromUnknownToolInput,
  editTargetFromUnknownToolInput,
  isBashTool,
  searchParamsFromUnknownToolInput,
} from "./toolClassification.js";

const ADAPTER_ENTRYPOINT = new URL(
  "../../../../node_modules/.pnpm/@zed-industries+claude-agent-acp@0.22.2/node_modules/@zed-industries/claude-agent-acp/dist/index.js",
  import.meta.url,
);

type ToolState = {
  toolName: string;
  rawInput?: Record<string, unknown>;
  parentToolUseId: string | null;
  command?: string;
  searchParams?: string;
  editTarget?: string;
  isBash: boolean;
  startedAtMs?: number;
  description?: string;
  subagentType?: string;
  isSubagentLauncher?: boolean;
  isPlanWrite?: boolean;
  filePath?: string;
};

type SubagentState = {
  agentId: string;
  agentType: string;
  toolUseId: string;
  launcherToolUseId: string | null;
  description: string;
  lastMessage: string;
  responseFallback: string;
};

type SessionClientOptions = {
  onText: (chunk: string) => Promise<void> | void;
  onThinking: (chunk: string) => Promise<void> | void;
  onToolStarted: NonNullable<Parameters<AgentRunner>[0]["onToolStarted"]>;
  onToolOutput: NonNullable<Parameters<AgentRunner>[0]["onToolOutput"]>;
  onToolFinished: NonNullable<Parameters<AgentRunner>[0]["onToolFinished"]>;
  onPermissionRequest: NonNullable<Parameters<AgentRunner>[0]["onPermissionRequest"]>;
  onPlanFileDetected: NonNullable<Parameters<AgentRunner>[0]["onPlanFileDetected"]>;
  onSubagentStarted?: NonNullable<Parameters<AgentRunner>[0]["onSubagentStarted"]>;
  onSubagentStopped?: NonNullable<Parameters<AgentRunner>[0]["onSubagentStopped"]>;
};

function mapOwnershipReason(raw: unknown): ClaudeOwnershipReason | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  const allowed: ClaudeOwnershipReason[] = [
    "resolved_tool_use_id",
    "resolved_parent_tool_use_id",
    "resolved_agent_id",
    "resolved_single_active_fallback",
    "resolved_subagent_path_hint",
    "unresolved_ambiguous_candidates",
    "unresolved_overlap_no_lineage",
    "unresolved_no_lineage",
  ];

  return allowed.includes(raw as ClaudeOwnershipReason) ? raw as ClaudeOwnershipReason : undefined;
}

function normalizeToolInput(rawInput: unknown): Record<string, unknown> {
  if (typeof rawInput !== "object" || rawInput == null || Array.isArray(rawInput)) {
    return {};
  }

  return rawInput as Record<string, unknown>;
}

function extractClaudeMeta(update: { _meta?: Record<string, unknown> | null }): Record<string, unknown> {
  const meta = (update._meta as Record<string, unknown> | undefined)?.claudeCode;
  if (typeof meta !== "object" || meta == null || Array.isArray(meta)) {
    return {};
  }

  return meta as Record<string, unknown>;
}

function extractToolName(update: ToolCall | ToolCallUpdate): string {
  const meta = extractClaudeMeta(update);
  const toolName = meta.toolName;
  if (typeof toolName === "string" && toolName.trim().length > 0) {
    return toolName;
  }

  if (typeof update.title === "string" && update.title.trim().length > 0) {
    return update.title.trim().split(/\s+/)[0] ?? "Tool";
  }

  return "Tool";
}

function extractParentToolUseId(update: { _meta?: Record<string, unknown> | null }): string | null {
  const value = extractClaudeMeta(update).parentToolUseId;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function buildToolState(update: ToolCall | ToolCallUpdate, previous?: ToolState): ToolState {
  const rawInput = normalizeToolInput(update.rawInput);
  const toolName = previous?.toolName ?? extractToolName(update);
  const command = commandFromUnknownToolInput(rawInput) ?? previous?.command;
  const searchParams = searchParamsFromUnknownToolInput(toolName, rawInput) ?? previous?.searchParams;
  const editTarget = editTargetFromUnknownToolInput(toolName, rawInput) ?? previous?.editTarget;
  const parentToolUseId = extractParentToolUseId(update) ?? previous?.parentToolUseId ?? null;
  const isBash = previous?.isBash ?? isBashTool(toolName);
  const description = typeof rawInput.description === "string"
    ? rawInput.description
    : typeof rawInput.prompt === "string"
      ? rawInput.prompt
      : previous?.description;
  const subagentType = typeof rawInput.subagent_type === "string" ? rawInput.subagent_type : previous?.subagentType;
  const filePath = typeof rawInput.file_path === "string"
    ? rawInput.file_path
    : typeof rawInput.path === "string"
      ? rawInput.path
      : previous?.filePath;
  const isSubagentLauncher = Boolean(previous?.isSubagentLauncher) || toolName === "Agent" || toolName === "Task";
  const isPlanWrite = Boolean(previous?.isPlanWrite)
    || ((toolName === "Write" || toolName === "Edit")
      && typeof filePath === "string"
      && filePath.includes(".claude/plans/"));

  return {
    toolName,
    rawInput: Object.keys(rawInput).length > 0 ? rawInput : previous?.rawInput,
    parentToolUseId,
    command,
    searchParams,
    editTarget,
    isBash,
    startedAtMs: previous?.startedAtMs,
    description,
    subagentType,
    isSubagentLauncher,
    isPlanWrite,
    filePath,
  };
}

function mapPermissionOption(toolName: string, decision: "allow" | "allow_always" | "deny"): string {
  if (toolName === "ExitPlanMode") {
    if (decision === "allow_always") {
      return "acceptEdits";
    }
    if (decision === "allow") {
      return "default";
    }
    return "plan";
  }

  if (decision === "allow_always") {
    return "allow_always";
  }
  if (decision === "allow") {
    return "allow";
  }
  return "reject";
}

function mapMode(permissionMode: string | undefined, autoAcceptTools: boolean | undefined): string {
  if (permissionMode === "plan") {
    return "plan";
  }
  if (autoAcceptTools) {
    return "acceptEdits";
  }
  return "default";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function meaningfulCompletionTitle(title: string | null | undefined, toolName: string): string {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (trimmed.length === 0) {
    return "";
  }

  const genericPattern = new RegExp(`^completed\\s+${escapeRegExp(toolName)}$`, "i");
  if (genericPattern.test(trimmed)) {
    return "";
  }

  if (/^(done|running)(?:\b|\s*[·-])/i.test(trimmed)) {
    return "";
  }

  return trimmed;
}

function resolveSubagentLastMessage(subagent: SubagentState, update: ToolCallUpdate): string {
  const streamedMessage = subagent.lastMessage.trim();
  if (streamedMessage.length > 0) {
    return streamedMessage;
  }

  const extractedResponse = extractSubagentResponse(update.rawOutput);
  if (extractedResponse.length > 0) {
    return extractedResponse;
  }

  if (subagent.responseFallback.trim().length > 0) {
    return subagent.responseFallback.trim();
  }

  return "";
}

function createPromptRequest(sessionId: string, prompt: string): PromptRequest {
  return {
    sessionId,
    messageId: randomUUID(),
    prompt: [{ type: "text", text: prompt }],
  };
}

class RuntimeAcpClient implements Client {
  private readonly toolStateById = new Map<string, ToolState>();
  private readonly subagentByToolUseId = new Map<string, SubagentState>();
  private output = "";

  constructor(private readonly options: SessionClientOptions) {}

  getOutput(): string {
    return this.output.trim();
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const toolCall = params.toolCall;
    const toolState = buildToolState(toolCall, this.toolStateById.get(toolCall.toolCallId));
    this.toolStateById.set(toolCall.toolCallId, toolState);

    if (toolState.toolName === "ExitPlanMode") {
      return {
        outcome: {
          outcome: "selected",
          optionId: "plan",
        },
      };
    }

    const decision = await this.options.onPermissionRequest({
      requestId: toolCall.toolCallId,
      toolName: toolState.toolName,
      toolInput: toolState.rawInput ?? {},
      blockedPath: null,
      decisionReason: null,
      suggestions: params.options,
      subagentOwnerToolUseId: toolState.parentToolUseId,
      launcherToolUseId: null,
      ownershipReason: mapOwnershipReason(extractClaudeMeta(toolCall).ownershipReason),
      ownershipCandidates: Array.isArray(extractClaudeMeta(toolCall).ownershipCandidates)
        ? (extractClaudeMeta(toolCall).ownershipCandidates as string[])
        : [],
      activeSubagentToolUseIds: Array.isArray(extractClaudeMeta(toolCall).activeSubagentToolUseIds)
        ? (extractClaudeMeta(toolCall).activeSubagentToolUseIds as string[])
        : [],
    });

    return {
      outcome: {
        outcome: "selected",
        optionId: mapPermissionOption(toolState.toolName, decision.decision),
      },
    };
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          const chunk = update.content.text;
          const parentToolUseId = extractParentToolUseId(update);
          if (parentToolUseId) {
            const subagent = this.subagentByToolUseId.get(parentToolUseId);
            if (subagent) {
              subagent.lastMessage = `${subagent.lastMessage}${chunk}`.trim();
            }
          } else {
            this.output += chunk;
            await this.options.onText(chunk);
          }
        }
        return;
      }
      case "agent_thought_chunk": {
        if (update.content.type === "text") {
          await this.options.onThinking(update.content.text);
        }
        return;
      }
      case "plan": {
        return;
      }
      case "tool_call": {
        const state = buildToolState(update, this.toolStateById.get(update.toolCallId));
        state.startedAtMs = Date.now();
        this.toolStateById.set(update.toolCallId, state);

        if (state.toolName !== "ExitPlanMode" && !state.isPlanWrite && !state.isSubagentLauncher) {
          await this.options.onToolStarted({
            toolName: state.toolName,
            toolUseId: update.toolCallId,
            parentToolUseId: state.parentToolUseId,
            ...(state.command ? { command: state.command } : {}),
            ...(state.searchParams ? { searchParams: state.searchParams } : {}),
            ...(state.editTarget ? { editTarget: state.editTarget } : {}),
            ...(state.isBash ? { shell: "bash" as const, isBash: true as const } : {}),
            ...(Array.isArray(extractClaudeMeta(update).ownershipCandidates)
              ? { ownershipCandidates: extractClaudeMeta(update).ownershipCandidates as string[] }
              : {}),
            ...(Array.isArray(extractClaudeMeta(update).activeSubagentToolUseIds)
              ? { activeSubagentToolUseIds: extractClaudeMeta(update).activeSubagentToolUseIds as string[] }
              : {}),
            ...(mapOwnershipReason(extractClaudeMeta(update).ownershipReason)
              ? { ownershipReason: mapOwnershipReason(extractClaudeMeta(update).ownershipReason) }
              : {}),
            ...(state.parentToolUseId ? { subagentOwnerToolUseId: state.parentToolUseId } : {}),
          });
        }

        return;
      }
      case "tool_call_update": {
        const state = buildToolState(update, this.toolStateById.get(update.toolCallId));
        this.toolStateById.set(update.toolCallId, state);

        const elapsedTimeSeconds = state.startedAtMs ? Math.max(0, (Date.now() - state.startedAtMs) / 1000) : 0;
        const meta = extractClaudeMeta(update);

        if (state.isSubagentLauncher) {
          let subagent = this.subagentByToolUseId.get(update.toolCallId);
          if (!subagent) {
            subagent = {
              agentId: update.toolCallId,
              agentType: state.subagentType ?? "general-purpose",
              toolUseId: update.toolCallId,
              launcherToolUseId: null,
              description: state.description ?? "",
              lastMessage: "",
              responseFallback: "",
            };
            this.subagentByToolUseId.set(update.toolCallId, subagent);
            await this.options.onSubagentStarted?.({
              agentId: subagent.agentId,
              agentType: subagent.agentType,
              toolUseId: subagent.toolUseId,
              description: subagent.description,
            } as any);
          }

          const completionTitle = meaningfulCompletionTitle(update.title, state.toolName ?? "Task");
          if (completionTitle.length > 0) {
            subagent.responseFallback = completionTitle;
          }

          if (update.status === "completed" || update.status === "failed") {
            await this.options.onSubagentStopped?.({
              agentId: subagent.agentId,
              agentType: subagent.agentType,
              toolUseId: subagent.toolUseId,
              description: subagent.description,
              lastMessage: resolveSubagentLastMessage(subagent, update),
              isResponseUpdate: false,
            } as any);
            this.subagentByToolUseId.delete(update.toolCallId);
          }
          return;
        }

        const activeSubagentToolUseIds = Array.isArray(meta.activeSubagentToolUseIds)
          ? meta.activeSubagentToolUseIds as string[]
          : [];
        const ownershipReason = mapOwnershipReason(meta.ownershipReason);
        const subagentOwnerToolUseId = state.parentToolUseId;

        if (state.toolName !== "ExitPlanMode" && !state.isPlanWrite && !state.isSubagentLauncher) {
          await this.options.onToolOutput({
            toolName: state.toolName,
            toolUseId: update.toolCallId,
            parentToolUseId: state.parentToolUseId,
            elapsedTimeSeconds,
            ...(Array.isArray(meta.ownershipCandidates)
              ? { ownershipCandidates: meta.ownershipCandidates as string[] }
              : {}),
            ...(activeSubagentToolUseIds.length > 0
              ? { activeSubagentToolUseIds }
              : {}),
            ...(ownershipReason ? { ownershipReason } : {}),
            ...(subagentOwnerToolUseId ? { subagentOwnerToolUseId } : {}),
          });
        }

        if (update.status === "completed" || update.status === "failed") {
          if (state.toolName === "ExitPlanMode") {
            return;
          }

          if (state.isPlanWrite && state.filePath && state.rawInput && typeof state.rawInput.content === "string") {
            await this.options.onPlanFileDetected({
              filePath: state.filePath,
              content: state.rawInput.content,
              source: state.filePath.includes(".claude/plans/") ? "claude_plan_file" : "streaming_fallback",
            });
            return;
          }

          const bashResult = state.isBash ? extractBashToolResult(update.rawOutput) : null;
          await this.options.onToolFinished({
            summary: typeof update.title === "string" && update.title.trim().length > 0
              ? update.title
              : `Completed ${state.toolName}`,
            precedingToolUseIds: [update.toolCallId],
            ...(state.command ? { command: state.command } : {}),
            ...(state.searchParams ? { searchParams: state.searchParams } : {}),
            ...(state.editTarget ? { editTarget: state.editTarget } : {}),
            ...(state.rawInput ? { toolInput: state.rawInput } : {}),
            ...(bashResult?.output ? { output: bashResult.output } : {}),
            ...(bashResult?.error ? { error: bashResult.error } : {}),
            ...(bashResult ? { truncated: bashResult.truncated, outputBytes: bashResult.outputBytes } : {}),
            ...(state.isBash ? { shell: "bash" as const, isBash: true as const } : {}),
            ...(update.status === "failed" && !bashResult?.error ? { error: "Tool failed" } : {}),
            ...(Array.isArray(meta.ownershipCandidates)
              ? { ownershipCandidates: meta.ownershipCandidates as string[] }
              : {}),
            ...(activeSubagentToolUseIds.length > 0
              ? { activeSubagentToolUseIds }
              : {}),
            ...(ownershipReason ? { ownershipReason } : {}),
            ...(subagentOwnerToolUseId ? { subagentOwnerToolUseId } : {}),
          });
        }
        return;
      }
      default:
        return;
    }
  }
}

async function initializeConnection(stream: acp.Stream): Promise<acp.ClientSideConnection> {
  const runtimeClient = new RuntimeAcpClient({
    onText: async () => {},
    onThinking: async () => {},
    onToolStarted: async () => {},
    onToolOutput: async () => {},
    onToolFinished: async () => {},
    onPermissionRequest: async () => ({ decision: "deny" }),
    onPlanFileDetected: async () => {},
  });
  const connection = new acp.ClientSideConnection(() => runtimeClient, stream);
  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: false,
        writeTextFile: false,
      },
      terminal: false,
      auth: {
        _meta: {
          gateway: true,
        },
      },
      _meta: {
        terminal_output: true,
      },
    },
    clientInfo: {
      name: "codesymphony-runtime",
      version: "0.1.0",
    },
  });
  return connection;
}

async function createOrResumeSession(
  connection: acp.ClientSideConnection,
  cwd: string,
  sessionId: string | null,
  model?: string,
): Promise<{ sessionId: string }> {
  if (sessionId) {
    try {
      await connection.unstable_resumeSession({
        sessionId,
        cwd,
        mcpServers: [],
      });
      return { sessionId };
    } catch {
      // fall through to newSession
    }
  }

  const session = await connection.newSession({
    cwd,
    mcpServers: [],
    _meta: {
      claudeCode: {
        options: model ? { model } : {},
      },
    },
  });
  return { sessionId: session.sessionId };
}

export const __testing = {
  meaningfulCompletionTitle,
  resolveSubagentLastMessage,
};

export const runClaudeViaAcp: AgentRunner = async ({
  prompt,
  sessionId,
  cwd,
  abortController,
  permissionMode,
  permissionProfile,
  autoAcceptTools,
  model,
  providerApiKey,
  providerBaseUrl,
  onText,
  onThinking,
  onToolStarted,
  onToolOutput,
  onToolFinished,
  onQuestionRequest,
  onPermissionRequest,
  onPlanFileDetected,
  onSubagentStarted,
  onSubagentStopped,
  onToolInstrumentation,
}) => {
  void onQuestionRequest;
  void onToolInstrumentation;

  const configuredExecutable = process.env.CLAUDE_CODE_EXECUTABLE?.trim() || DEFAULT_CLAUDE_EXECUTABLE;
  const baseEnv = { ...process.env } as NodeJS.ProcessEnv;
  delete baseEnv.CLAUDECODE;

  const candidateExecutables = buildExecutableCandidates(configuredExecutable);
  const claudeExecutable = selectExecutableForCurrentProcess(candidateExecutables, baseEnv);

  const child = spawn(process.execPath, [ADAPTER_ENTRYPOINT.pathname], {
    cwd,
    env: {
      ...baseEnv,
      MAX_THINKING_TOKENS: "0",
      CLAUDE_CODE_EXECUTABLE: claudeExecutable,
      ANTHROPIC_API_KEY: providerApiKey || baseEnv.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: providerBaseUrl || baseEnv.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: providerApiKey || baseEnv.ANTHROPIC_AUTH_TOKEN,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const runtimeClient = new RuntimeAcpClient({
    onText,
    onThinking,
    onToolStarted,
    onToolOutput,
    onToolFinished,
    onPermissionRequest,
    onPlanFileDetected,
    onSubagentStarted,
    onSubagentStopped,
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  const connection = new acp.ClientSideConnection(() => runtimeClient, stream);
  let activeSessionId = sessionId;

  try {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
        auth: {
          _meta: {
            gateway: true,
          },
        },
        _meta: {
          terminal_output: true,
        },
      },
      clientInfo: {
        name: "codesymphony-runtime",
        version: "0.1.0",
      },
    });

    if (providerApiKey && providerBaseUrl) {
      await connection.authenticate({
        methodId: "gateway",
        _meta: {
          gateway: {
            baseUrl: providerBaseUrl,
            headers: {
              Authorization: `Bearer ${providerApiKey}`,
              "x-api-key": providerApiKey,
            },
          },
        },
      });
    }

    const session = await createOrResumeSession(connection, cwd, sessionId, model);
    activeSessionId = session.sessionId;

    const modeId = mapMode(permissionMode, autoAcceptTools);
    await connection.setSessionMode({
      sessionId: activeSessionId,
      modeId,
    });

    if (abortController) {
      abortController.signal.addEventListener("abort", () => {
        if (activeSessionId) {
          void connection.cancel({ sessionId: activeSessionId });
        }
      }, { once: true });
    }

    const response: PromptResponse = await connection.prompt(createPromptRequest(activeSessionId, prompt));
    if (response.stopReason === "cancelled" && abortController?.signal.aborted) {
      throw new Error("Cancelled");
    }

    return {
      output: runtimeClient.getOutput(),
      sessionId: activeSessionId,
    };
  } catch (error) {
    throw withClaudeSetupHint(error, [], claudeExecutable);
  } finally {
    child.kill();
  }
};
