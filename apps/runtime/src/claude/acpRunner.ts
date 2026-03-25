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
import type { AvailableCommand, ChatThreadPermissionProfile } from "@codesymphony/shared-types";
import type {
  AgentRunner,
  ClaudeOwnershipReason,
  ClaudeToolInstrumentationDecision,
  ClaudeToolInstrumentationEvent,
} from "../types.js";
import { extractBashToolResult } from "./bashResult.js";
import { extractSubagentResponse } from "./subagentTranscript.js";
import {
  DEFAULT_CLAUDE_EXECUTABLE,
  buildExecutableCandidates,
  selectExecutableForCurrentProcess,
  captureStderrLine,
  withClaudeSetupHint,
} from "./executableResolver.js";
import { sanitizeForLog, toIso, truncateForPreview } from "./sanitize.js";
import {
  commandFromUnknownToolInput,
  editTargetFromUnknownToolInput,
  isBashTool,
  searchParamsFromUnknownToolInput,
} from "./toolClassification.js";
import { shouldAutoAllowReviewGitPermission } from "./reviewGitPermissionPolicy.js";

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
  permissionProfile?: ChatThreadPermissionProfile;
  instrumentContext: ClaudeToolInstrumentationEvent["threadContext"];
  onText: (chunk: string) => Promise<void> | void;
  onThinking: (chunk: string) => Promise<void> | void;
  onToolStarted: NonNullable<Parameters<AgentRunner>[0]["onToolStarted"]>;
  onToolOutput: NonNullable<Parameters<AgentRunner>[0]["onToolOutput"]>;
  onToolFinished: NonNullable<Parameters<AgentRunner>[0]["onToolFinished"]>;
  onPermissionRequest: NonNullable<Parameters<AgentRunner>[0]["onPermissionRequest"]>;
  onPlanFileDetected: NonNullable<Parameters<AgentRunner>[0]["onPlanFileDetected"]>;
  onSubagentStarted?: NonNullable<Parameters<AgentRunner>[0]["onSubagentStarted"]>;
  onSubagentStopped?: NonNullable<Parameters<AgentRunner>[0]["onSubagentStopped"]>;
  onAvailableCommandsUpdated?: NonNullable<Parameters<AgentRunner>[0]["onAvailableCommandsUpdated"]>;
  onToolInstrumentation?: NonNullable<Parameters<AgentRunner>[0]["onToolInstrumentation"]>;
};

type PermissionMetadata = {
  blockedPath: string | null;
  decisionReason: string | null;
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

function extractPermissionMetadata(toolCall: ToolCall | ToolCallUpdate): PermissionMetadata {
  const meta = extractClaudeMeta(toolCall);
  const blockedPath = typeof meta.blockedPath === "string" && meta.blockedPath.trim().length > 0
    ? meta.blockedPath.trim()
    : null;
  const decisionReason = typeof meta.decisionReason === "string" && meta.decisionReason.trim().length > 0
    ? meta.decisionReason.trim()
    : null;
  return { blockedPath, decisionReason };
}

function formatPlanContent(entries: Array<{ content?: unknown; status?: unknown }>): string {
  const lines = entries
    .map((entry) => {
      const content = typeof entry.content === "string" ? entry.content.trim() : "";
      if (content.length === 0) {
        return null;
      }
      const status = entry.status === "completed"
        ? "[x]"
        : entry.status === "in_progress"
          ? "[-]"
          : "[ ]";
      return `${status} ${content}`;
    })
    .filter((line): line is string => line !== null);

  if (lines.length === 0) {
    return "";
  }

  return `# Plan\n\n${lines.join("\n")}`;
}

function buildPlanFallbackPath(): string {
  return ".claude/plans/acp-plan.md";
}

function normalizeAvailableCommands(rawCommands: unknown): AvailableCommand[] {
  if (!Array.isArray(rawCommands)) {
    return [];
  }

  return rawCommands.flatMap((rawCommand) => {
    if (typeof rawCommand !== "object" || rawCommand == null || Array.isArray(rawCommand)) {
      return [];
    }

    const command = rawCommand as Record<string, unknown>;
    const name = typeof command.name === "string" ? command.name.trim() : "";
    if (name.length === 0) {
      return [];
    }

    const description = typeof command.description === "string" ? command.description : "";
    const rawInput = command.input;
    const input = typeof rawInput === "object" && rawInput != null && !Array.isArray(rawInput)
      && typeof (rawInput as Record<string, unknown>).hint === "string"
      ? { hint: (rawInput as Record<string, unknown>).hint as string }
      : null;

    return [{ name, description, ...(input ? { input } : {}) }];
  });
}

async function emitInstrumentation(
  onToolInstrumentation: SessionClientOptions["onToolInstrumentation"],
  event: ClaudeToolInstrumentationEvent,
): Promise<void> {
  if (!onToolInstrumentation) {
    return;
  }

  try {
    await onToolInstrumentation(event);
  } catch {
    // Instrumentation must never interrupt the stream.
  }
}

function mapDecisionForInstrumentation(decision: "allow" | "allow_always" | "deny"): ClaudeToolInstrumentationDecision {
  if (decision === "deny") {
    return "deny";
  }
  if (decision === "allow_always") {
    return "auto_allow";
  }
  return "allow";
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
  private pendingPlanContent = "";
  private availableCommandsLoaded = false;
  private readonly availableCommandsWaiters = new Set<() => void>();

  constructor(private readonly options: SessionClientOptions) {}

  private async emitToolInstrumentation(event: ClaudeToolInstrumentationEvent): Promise<void> {
    await emitInstrumentation(this.options.onToolInstrumentation, event);
  }

  async waitForAvailableCommands(timeoutMs = 1000): Promise<void> {
    if (this.availableCommandsLoaded) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.availableCommandsWaiters.delete(handleResolve);
        resolve();
      }, timeoutMs);

      const handleResolve = () => {
        clearTimeout(timer);
        this.availableCommandsWaiters.delete(handleResolve);
        resolve();
      };

      this.availableCommandsWaiters.add(handleResolve);
    });
  }

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

    const meta = extractClaudeMeta(toolCall);
    const permissionMeta = extractPermissionMetadata(toolCall);
    const ownershipReason = mapOwnershipReason(meta.ownershipReason);
    const ownershipCandidates = Array.isArray(meta.ownershipCandidates)
      ? meta.ownershipCandidates as string[]
      : [];
    const activeSubagentToolUseIds = Array.isArray(meta.activeSubagentToolUseIds)
      ? meta.activeSubagentToolUseIds as string[]
      : [];

    await this.emitToolInstrumentation({
      stage: "requested",
      toolUseId: toolCall.toolCallId,
      toolName: toolState.toolName,
      parentToolUseId: toolState.parentToolUseId,
      threadContext: this.options.instrumentContext,
      preview: {
        ...(toolState.command ? { command: toolState.command } : {}),
        input: sanitizeForLog(toolState.rawInput ?? {}),
        blockedPath: permissionMeta.blockedPath,
        decisionReason: permissionMeta.decisionReason,
        suggestionsCount: params.options.length,
      },
    });

    if (toolState.toolName === "ExitPlanMode") {
      return {
        outcome: {
          outcome: "selected",
          optionId: "plan",
        },
      };
    }

    if (shouldAutoAllowReviewGitPermission({
      permissionProfile: this.options.permissionProfile,
      isBash: toolState.isBash,
      command: toolState.command,
    })) {
      await this.emitToolInstrumentation({
        stage: "decision",
        toolUseId: toolCall.toolCallId,
        toolName: toolState.toolName,
        parentToolUseId: toolState.parentToolUseId,
        decision: "auto_allow",
        threadContext: this.options.instrumentContext,
        preview: {
          ...(toolState.command ? { command: toolState.command } : {}),
          input: sanitizeForLog(toolState.rawInput ?? {}),
          blockedPath: permissionMeta.blockedPath,
          decisionReason: permissionMeta.decisionReason,
          suggestionsCount: params.options.length,
        },
      });
      return {
        outcome: {
          outcome: "selected",
          optionId: "allow",
        },
      };
    }

    const decision = await this.options.onPermissionRequest({
      requestId: toolCall.toolCallId,
      toolName: toolState.toolName,
      toolInput: toolState.rawInput ?? {},
      blockedPath: permissionMeta.blockedPath,
      decisionReason: permissionMeta.decisionReason,
      suggestions: params.options,
      subagentOwnerToolUseId: toolState.parentToolUseId,
      launcherToolUseId: null,
      ownershipReason,
      ownershipCandidates,
      activeSubagentToolUseIds,
    });

    await this.emitToolInstrumentation({
      stage: "decision",
      toolUseId: toolCall.toolCallId,
      toolName: toolState.toolName,
      parentToolUseId: toolState.parentToolUseId,
      decision: mapDecisionForInstrumentation(decision.decision),
      threadContext: this.options.instrumentContext,
      preview: {
        ...(toolState.command ? { command: toolState.command } : {}),
        input: sanitizeForLog(toolState.rawInput ?? {}),
        blockedPath: permissionMeta.blockedPath,
        decisionReason: permissionMeta.decisionReason,
        suggestionsCount: params.options.length,
      },
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
        const entries = Array.isArray(update.entries) ? update.entries : [];
        this.pendingPlanContent = formatPlanContent(entries);
        if (this.pendingPlanContent.trim().length > 0) {
          await this.options.onPlanFileDetected({
            filePath: buildPlanFallbackPath(),
            content: this.pendingPlanContent,
            source: "streaming_fallback",
          });
        }
        return;
      }
      case "available_commands_update": {
        const availableCommands = normalizeAvailableCommands(update.availableCommands);
        this.availableCommandsLoaded = true;
        await this.options.onAvailableCommandsUpdated?.({ availableCommands });
        for (const waiter of this.availableCommandsWaiters) {
          waiter();
        }
        this.availableCommandsWaiters.clear();
        return;
      }
      case "tool_call": {
        const state = buildToolState(update, this.toolStateById.get(update.toolCallId));
        state.startedAtMs = Date.now();
        this.toolStateById.set(update.toolCallId, state);

        const meta = extractClaudeMeta(update);
        const ownershipReason = mapOwnershipReason(meta.ownershipReason);
        const ownershipCandidates = Array.isArray(meta.ownershipCandidates)
          ? meta.ownershipCandidates as string[]
          : [];
        const activeSubagentToolUseIds = Array.isArray(meta.activeSubagentToolUseIds)
          ? meta.activeSubagentToolUseIds as string[]
          : [];

        if (state.toolName !== "ExitPlanMode" && !state.isPlanWrite && !state.isSubagentLauncher) {
          await this.options.onToolStarted({
            toolName: state.toolName,
            toolUseId: update.toolCallId,
            parentToolUseId: state.parentToolUseId,
            ...(state.command ? { command: state.command } : {}),
            ...(state.searchParams ? { searchParams: state.searchParams } : {}),
            ...(state.editTarget ? { editTarget: state.editTarget } : {}),
            ...(state.isBash ? { shell: "bash" as const, isBash: true as const } : {}),
            ...(ownershipCandidates.length > 0 ? { ownershipCandidates } : {}),
            ...(activeSubagentToolUseIds.length > 0 ? { activeSubagentToolUseIds } : {}),
            ...(ownershipReason ? { ownershipReason } : {}),
            ...(state.parentToolUseId ? { subagentOwnerToolUseId: state.parentToolUseId } : {}),
          });

          await this.emitToolInstrumentation({
            stage: "started",
            toolUseId: update.toolCallId,
            toolName: state.toolName,
            parentToolUseId: state.parentToolUseId,
            threadContext: this.options.instrumentContext,
            timing: {
              startedAt: toIso(state.startedAtMs),
            },
            preview: {
              ...(state.command ? { command: state.command } : {}),
              startSource: "sdk.stream.tool_progress",
            },
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
          const summary = typeof update.title === "string" && update.title.trim().length > 0
            ? update.title
            : `Completed ${state.toolName}`;
          const error = bashResult?.error ?? (update.status === "failed" ? "Tool failed" : undefined);

          await this.options.onToolFinished({
            summary,
            precedingToolUseIds: [update.toolCallId],
            ...(state.command ? { command: state.command } : {}),
            ...(state.searchParams ? { searchParams: state.searchParams } : {}),
            ...(state.editTarget ? { editTarget: state.editTarget } : {}),
            ...(state.rawInput ? { toolInput: state.rawInput } : {}),
            ...(bashResult?.output ? { output: bashResult.output } : {}),
            ...(error ? { error } : {}),
            ...(bashResult ? { truncated: bashResult.truncated, outputBytes: bashResult.outputBytes } : {}),
            ...(state.isBash ? { shell: "bash" as const, isBash: true as const } : {}),
            ...(Array.isArray(meta.ownershipCandidates)
              ? { ownershipCandidates: meta.ownershipCandidates as string[] }
              : {}),
            ...(activeSubagentToolUseIds.length > 0
              ? { activeSubagentToolUseIds }
              : {}),
            ...(ownershipReason ? { ownershipReason } : {}),
            ...(subagentOwnerToolUseId ? { subagentOwnerToolUseId } : {}),
          });

          const finishedAtMs = Date.now();
          const startedAtMs = state.startedAtMs;
          await this.emitToolInstrumentation({
            stage: update.status === "failed" ? "failed" : "finished",
            toolUseId: update.toolCallId,
            toolName: state.toolName,
            parentToolUseId: state.parentToolUseId,
            summary,
            threadContext: this.options.instrumentContext,
            timing: {
              elapsedTimeSeconds,
              ...(startedAtMs ? {
                startedAt: toIso(startedAtMs),
                durationMs: finishedAtMs - startedAtMs,
              } : {}),
              finishedAt: toIso(finishedAtMs),
            },
            preview: {
              ...(state.command ? { command: state.command } : {}),
              ...(state.isBash
                ? {
                  output: typeof bashResult?.output === "string" ? bashResult.output : undefined,
                  error,
                  truncated: bashResult?.truncated ?? false,
                  outputBytes: bashResult?.outputBytes ?? 0,
                }
                : {
                  output: typeof update.rawOutput === "string"
                    ? truncateForPreview(update.rawOutput)
                    : undefined,
                }),
            },
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
    instrumentContext: {
      cwd: process.cwd(),
      sessionId: null,
      permissionMode: "default",
      autoAcceptTools: false,
      permissionProfile: "default",
    },
    onText: async () => {},
    onThinking: async () => {},
    onToolStarted: async () => {},
    onToolOutput: async () => {},
    onToolFinished: async () => {},
    onPermissionRequest: async () => ({ decision: "deny" }),
    onPlanFileDetected: async () => {},
    onAvailableCommandsUpdated: async () => {},
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

async function applySessionModel(connection: acp.ClientSideConnection, sessionId: string, model?: string): Promise<void> {
  if (!model) {
    return;
  }

  await connection.unstable_setSessionModel({
    sessionId,
    modelId: model,
  });
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
      await applySessionModel(connection, sessionId, model);
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
  await applySessionModel(connection, session.sessionId, model);
  return { sessionId: session.sessionId };
}

export const __testing = {
  meaningfulCompletionTitle,
  resolveSubagentLastMessage,
  extractPermissionMetadata,
  formatPlanContent,
  RuntimeAcpClient,
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
  onAvailableCommandsUpdated,
  loadAvailableCommands,
  prefetchOnly,
  onToolInstrumentation,
}) => {
  void onQuestionRequest;

  const recentStderr: string[] = [];
  const configuredExecutable = process.env.CLAUDE_CODE_EXECUTABLE?.trim() || DEFAULT_CLAUDE_EXECUTABLE;
  const baseEnv = { ...process.env } as NodeJS.ProcessEnv;
  delete baseEnv.CLAUDECODE;
  delete baseEnv.ANTHROPIC_API_KEY;
  delete baseEnv.ANTHROPIC_BASE_URL;
  delete baseEnv.ANTHROPIC_AUTH_TOKEN;
  delete baseEnv.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete baseEnv.ANTHROPIC_DEFAULT_OPUS_MODEL;
  delete baseEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;

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
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (data: string | Buffer) => {
    captureStderrLine(recentStderr, typeof data === "string" ? data : data.toString("utf8"));
  });

  const runtimeClient = new RuntimeAcpClient({
    permissionProfile,
    instrumentContext: {
      cwd,
      sessionId,
      permissionMode: permissionMode ?? "default",
      autoAcceptTools: Boolean(autoAcceptTools),
      permissionProfile: permissionProfile ?? "default",
    },
    onText,
    onThinking,
    onToolStarted,
    onToolOutput,
    onToolFinished,
    onPermissionRequest,
    onPlanFileDetected,
    onSubagentStarted,
    onSubagentStopped,
    onAvailableCommandsUpdated,
    onToolInstrumentation,
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

    let response: PromptResponse | null = null;
    if (prefetchOnly) {
      await runtimeClient.waitForAvailableCommands();
    } else {
      response = await connection.prompt(createPromptRequest(activeSessionId, prompt));

      if (loadAvailableCommands) {
        await runtimeClient.waitForAvailableCommands();
      }
      if (response.stopReason === "cancelled" && abortController?.signal.aborted) {
        throw new Error("Cancelled");
      }
    }

    return {
      output: runtimeClient.getOutput(),
      sessionId: activeSessionId,
    };
  } catch (error) {
    throw withClaudeSetupHint(error, recentStderr, claudeExecutable);
  } finally {
    child.kill();
  }
};
