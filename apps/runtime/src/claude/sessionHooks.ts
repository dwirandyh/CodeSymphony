import { readFileSync } from "node:fs";

import type { ClaudeToolInstrumentationDecision, ClaudeToolInstrumentationEvent } from "../types.js";

import { sanitizeForLog } from "./sanitize.js";
import {
  isBashTool,
  isEditTool,
  commandFromToolInput,
  commandFromUnknownToolInput,
  readTargetFromUnknownToolInput,
  searchParamsFromUnknownToolInput,
  editTargetFromUnknownToolInput,
  type ToolMetadata,
} from "./toolClassification.js";
import { completionSummaryFromMetadata, failureSummaryFromMetadata } from "./toolSummary.js";
import { extractBashToolResult } from "./bashResult.js";
import { parseSubagentTranscript, extractSubagentResponse } from "./subagentTranscript.js";
import { findLatestPlanFile } from "./planFile.js";

import type { InstrumentContext, SessionMaps } from "./sessionInstrumentation.js";
import { buildMetadataFromHookInput, buildFinishedTimingPreview, buildToolFinishedPayload } from "./sessionInstrumentation.js";

export type HookCallbacks = {
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
  onToolFinished: (payload: {
    summary: string;
    precedingToolUseIds: string[];
    subagentResponse?: string;
    command?: string;
    searchParams?: string;
    editTarget?: string;
    toolInput?: Record<string, unknown>;
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
  }) => Promise<{ decision: string; message?: string }> | { decision: string; message?: string };
  onPlanFileDetected: (payload: {
    filePath: string;
    content: string;
    source?: "claude_plan_file" | "streaming_fallback";
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
    isResponseUpdate?: boolean;
  }) => Promise<void> | void;
};

export type SessionState = {
  finalOutput: string;
  planFileDetected: boolean;
  queryStartTimestamp: number;
};

export function createCanUseTool(
  callbacks: HookCallbacks,
  emitInstrumentation: (event: ClaudeToolInstrumentationEvent) => Promise<void>,
  emitDecision: (
    toolUseId: string,
    decision: ClaudeToolInstrumentationDecision,
    toolName: string,
    parentToolUseId: string | null,
    preview: ClaudeToolInstrumentationEvent["preview"],
  ) => Promise<void>,
  maps: SessionMaps,
  instrumentContext: InstrumentContext,
  state: SessionState,
  permissionMode: string | undefined,
  autoAcceptTools: boolean | undefined,
) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      toolUseID: string;
      blockedPath?: string;
      decisionReason?: string;
      suggestions?: unknown[];
    },
  ) => {
    const toolUseId = options.toolUseID;
    const command = commandFromToolInput(input);
    const isBash = isBashTool(toolName);
    const nowMs = Date.now();

    maps.toolMetadataByUseId.set(toolUseId, {
      toolName,
      command,
      readTarget: readTargetFromUnknownToolInput(toolName, input),
      searchParams: searchParamsFromUnknownToolInput(toolName, input),
      editTarget: editTargetFromUnknownToolInput(toolName, input),
      isBash,
    });
    maps.subagentToolInputByUseId.set(toolUseId, input);
    maps.requestedToolByUseId.set(toolUseId, {
      toolName,
      parentToolUseId: null,
      requestedAtMs: nowMs,
    });
    await emitInstrumentation({
      stage: "requested",
      toolUseId,
      toolName,
      parentToolUseId: null,
      threadContext: instrumentContext,
      timing: {
        startedAt: new Date(nowMs).toISOString(),
      },
      preview: {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
        blockedPath: options.blockedPath ?? null,
        decisionReason: options.decisionReason ?? null,
        suggestionsCount: options.suggestions?.length ?? 0,
      },
    });

    if (permissionMode === "plan" && toolName !== "AskUserQuestion") {
      if (!state.planFileDetected && state.finalOutput.trim().length > 0) {
        state.planFileDetected = true;
        let detectedPlan: { filePath: string; content: string; source: "claude_plan_file" | "streaming_fallback" } | null = null;
        for (const fp of maps.sessionPersistedPlanFiles) {
          try {
            const content = readFileSync(fp, "utf-8");
            if (content.trim().length > 0) {
              detectedPlan = { filePath: fp, content, source: "claude_plan_file" };
            }
          } catch { /* skip unreadable */ }
        }
        if (!detectedPlan) {
          const planFile = findLatestPlanFile(state.queryStartTimestamp);
          if (planFile) {
            detectedPlan = { ...planFile, source: "claude_plan_file" };
          }
        }
        await callbacks.onPlanFileDetected(detectedPlan ?? {
          filePath: "streaming-plan",
          content: state.finalOutput.trim(),
          source: "streaming_fallback",
        });
      }
      await emitDecision(toolUseId, "plan_deny", toolName, null, {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
        decisionReason: "Plan requires user approval before execution.",
      });
      return {
        behavior: "deny" as const,
        message: "Plan requires user approval before execution.",
      };
    }

    if (toolName === "AskUserQuestion") {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const result = await callbacks.onQuestionRequest({
        requestId: toolUseId,
        questions,
      });
      await emitDecision(toolUseId, "allow", toolName, null, {
        input: sanitizeForLog(input),
      });
      return {
        behavior: "allow" as const,
        updatedInput: { ...input, answers: result.answers },
      };
    }

    const requiresUserApproval = Boolean(
      options.blockedPath || options.decisionReason || (options.suggestions?.length ?? 0) > 0,
    );

    if (requiresUserApproval && isEditTool(toolName)) {
      await emitDecision(toolUseId, "auto_allow", toolName, null, {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
        blockedPath: options.blockedPath ?? null,
        decisionReason: options.decisionReason ?? null,
        suggestionsCount: options.suggestions?.length ?? 0,
      });
      return {
        behavior: "allow" as const,
        updatedInput: input,
      };
    }

    if (!requiresUserApproval) {
      await emitDecision(toolUseId, "allow", toolName, null, {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
      });
      return {
        behavior: "allow" as const,
        updatedInput: input,
      };
    }

    if (autoAcceptTools) {
      await emitDecision(toolUseId, "auto_allow", toolName, null, {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
        blockedPath: options.blockedPath ?? null,
        decisionReason: options.decisionReason ?? null,
        suggestionsCount: options.suggestions?.length ?? 0,
      });
      return {
        behavior: "allow" as const,
        updatedInput: input,
      };
    }

    const decision = await callbacks.onPermissionRequest({
      requestId: toolUseId,
      toolName,
      toolInput: input,
      blockedPath: options.blockedPath ?? null,
      decisionReason: options.decisionReason ?? null,
      suggestions: options.suggestions ?? null,
    });

    if (decision.decision === "allow") {
      await emitDecision(toolUseId, "allow", toolName, null, {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
        blockedPath: options.blockedPath ?? null,
        decisionReason: options.decisionReason ?? null,
        suggestionsCount: options.suggestions?.length ?? 0,
      });
      return {
        behavior: "allow" as const,
        updatedInput: input,
      };
    }

    await emitDecision(toolUseId, "deny", toolName, null, {
      ...(command ? { command } : {}),
      input: sanitizeForLog(input),
      blockedPath: options.blockedPath ?? null,
      decisionReason: options.decisionReason ?? null,
      suggestionsCount: options.suggestions?.length ?? 0,
    });

    return {
      behavior: "deny" as const,
      message: decision.message ?? "Tool execution denied by user.",
    };
  };
}

export function createPreToolUseHook(
  markStarted: (
    toolUseId: string,
    toolName: string,
    parentToolUseId: string | null,
    startSource: "sdk.hook.pre_tool_use" | "sdk.stream.tool_progress",
    metadata?: ToolMetadata,
  ) => Promise<void>,
  maps: SessionMaps,
) {
  return async (hookInput: Record<string, unknown>, toolUseID?: string) => {
    if (hookInput.hook_event_name !== "PreToolUse") {
      return { continue: true };
    }

    const hookToolUseId = (hookInput.tool_use_id as string) || toolUseID;
    if (!hookToolUseId) {
      return { continue: true };
    }

    const command = commandFromUnknownToolInput(hookInput.tool_input);
    maps.toolMetadataByUseId.set(hookToolUseId, {
      toolName: hookInput.tool_name as string,
      command,
      readTarget: readTargetFromUnknownToolInput(hookInput.tool_name as string, hookInput.tool_input),
      searchParams: searchParamsFromUnknownToolInput(hookInput.tool_name as string, hookInput.tool_input),
      isBash: isBashTool(hookInput.tool_name as string),
    });
    maps.requestedToolByUseId.set(hookToolUseId, {
      toolName: hookInput.tool_name as string,
      parentToolUseId: null,
      requestedAtMs: Date.now(),
    });

    await markStarted(
      hookToolUseId,
      hookInput.tool_name as string,
      null,
      "sdk.hook.pre_tool_use",
      maps.toolMetadataByUseId.get(hookToolUseId),
    );

    return { continue: true };
  };
}

export function createPostToolUseHook(
  callbacks: HookCallbacks,
  emitInstrumentation: (event: ClaudeToolInstrumentationEvent) => Promise<void>,
  maps: SessionMaps,
  instrumentContext: InstrumentContext,
) {
  return async (hookInput: Record<string, unknown>, toolUseID?: string) => {
    if (hookInput.hook_event_name !== "PostToolUse") {
      return { continue: true };
    }

    const hookToolUseId = (hookInput.tool_use_id as string) || toolUseID;
    if (!hookToolUseId) {
      return { continue: true };
    }

    const metadata = buildMetadataFromHookInput(hookInput, hookToolUseId, maps.toolMetadataByUseId);
    const bashResult = extractBashToolResult(hookInput.tool_response);
    if (metadata.isBash && bashResult) {
      maps.bashResultByToolUseId.set(hookToolUseId, bashResult);
    }

    if ((hookInput.tool_name as string).toLowerCase() === "task") {
      const responseText = extractSubagentResponse(hookInput.tool_response);
      if (responseText) {
        maps.subagentResponseByUseId.set(hookToolUseId, responseText);
      }
    }

    if (!maps.finishedToolUseIds.has(hookToolUseId)) {
      const finishedAtMs = Date.now();
      const completionSummary = completionSummaryFromMetadata(metadata, hookInput.tool_input);
      await callbacks.onToolFinished({
        ...buildToolFinishedPayload(
          metadata,
          completionSummary,
          [hookToolUseId],
          bashResult ?? undefined,
          maps.subagentResponseByUseId.get(hookToolUseId),
        ),
        ...(metadata.editTarget ? { toolInput: hookInput.tool_input as Record<string, unknown> } : {}),
      });
      const { timing, preview } = buildFinishedTimingPreview(
        hookToolUseId, metadata, finishedAtMs, maps, bashResult ?? undefined, hookInput.tool_response,
      );
      await emitInstrumentation({
        stage: "finished",
        toolUseId: hookToolUseId,
        toolName: metadata.toolName,
        parentToolUseId: null,
        summary: completionSummary,
        threadContext: instrumentContext,
        timing,
        preview,
      });
      maps.finishedToolUseIds.add(hookToolUseId);
    }

    const capturedResponse = maps.subagentResponseByUseId.get(hookToolUseId);
    if (capturedResponse) {
      await callbacks.onSubagentStopped({
        agentId: "",
        agentType: "",
        toolUseId: hookToolUseId,
        description: "",
        lastMessage: capturedResponse,
        isResponseUpdate: true,
      });
      maps.subagentResponseByUseId.delete(hookToolUseId);
    }

    return { continue: true };
  };
}

export function createPostToolUseFailureHook(
  callbacks: HookCallbacks,
  emitInstrumentation: (event: ClaudeToolInstrumentationEvent) => Promise<void>,
  maps: SessionMaps,
  instrumentContext: InstrumentContext,
) {
  return async (hookInput: Record<string, unknown>, toolUseID?: string) => {
    if (hookInput.hook_event_name !== "PostToolUseFailure") {
      return { continue: true };
    }

    const hookToolUseId = (hookInput.tool_use_id as string) || toolUseID;
    if (!hookToolUseId) {
      return { continue: true };
    }

    const metadata = buildMetadataFromHookInput(hookInput, hookToolUseId, maps.toolMetadataByUseId);
    const command = metadata?.command ?? commandFromUnknownToolInput(hookInput.tool_input);
    if (maps.finishedToolUseIds.has(hookToolUseId)) {
      return { continue: true };
    }

    const finishedAtMs = Date.now();
    const failureSummary = failureSummaryFromMetadata(metadata, hookInput.tool_input, command);
    await callbacks.onToolFinished({
      summary: failureSummary,
      precedingToolUseIds: [hookToolUseId],
      ...(metadata.editTarget
        ? { editTarget: metadata.editTarget }
        : {}),
      ...(metadata.isBash
        ? {
          command,
          shell: "bash" as const,
          isBash: true as const,
        }
        : metadata.searchParams
          ? { searchParams: metadata.searchParams }
          : {}),
      error: hookInput.error as string,
      truncated: false,
      outputBytes: Buffer.byteLength(hookInput.error as string, "utf8"),
    });
    const { timing } = buildFinishedTimingPreview(hookToolUseId, metadata, finishedAtMs, maps);
    await emitInstrumentation({
      stage: "failed",
      toolUseId: hookToolUseId,
      toolName: metadata?.toolName ?? (hookInput.tool_name as string),
      parentToolUseId: null,
      summary: failureSummary,
      threadContext: instrumentContext,
      timing,
      preview: {
        ...(command ? { command } : {}),
        error: sanitizeForLog(hookInput.error as string) as string,
        truncated: false,
        outputBytes: Buffer.byteLength(hookInput.error as string, "utf8"),
      },
    });
    maps.finishedToolUseIds.add(hookToolUseId);
    return { continue: true };
  };
}

export function createSubagentStartHook(
  callbacks: HookCallbacks,
  maps: SessionMaps,
) {
  return async (hookInput: Record<string, unknown>, toolUseID?: string) => {
    if (hookInput.hook_event_name !== "SubagentStart") {
      return { continue: true };
    }

    const agentId = String(hookInput.agent_id ?? "");
    const agentType = String(hookInput.agent_type ?? "unknown");
    const resolvedToolUseId = String(hookInput.tool_use_id || toolUseID || "");

    if (agentId && resolvedToolUseId) {
      maps.agentIdToToolUseId.set(agentId, resolvedToolUseId);
    }

    const toolInput = maps.subagentToolInputByUseId.get(resolvedToolUseId);
    const description = toolInput
      ? String((toolInput as Record<string, unknown>).description
        ?? (toolInput as Record<string, unknown>).prompt
        ?? (toolInput as Record<string, unknown>).task
        ?? (toolInput as Record<string, unknown>).Task
        ?? "")
      : "";

    await callbacks.onSubagentStarted({
      agentId,
      agentType,
      toolUseId: resolvedToolUseId,
      description,
    });

    return {};
  };
}

export function createSubagentStopHook(
  callbacks: HookCallbacks,
  maps: SessionMaps,
) {
  return async (hookInput: Record<string, unknown>, toolUseID?: string) => {
    if (hookInput.hook_event_name !== "SubagentStop") {
      return { continue: true };
    }

    const agentId = String(hookInput.agent_id ?? "");
    const agentType = String(hookInput.agent_type ?? "unknown");
    const resolvedToolUseId = maps.agentIdToToolUseId.get(agentId)
      ?? String(hookInput.tool_use_id || toolUseID || "");

    let description = "";
    let lastMessage = "";
    const transcriptPath = String(hookInput.agent_transcript_path ?? "");
    if (transcriptPath) {
      try {
        const transcriptContent = readFileSync(transcriptPath, "utf-8");
        const parsed = parseSubagentTranscript(transcriptContent);
        description = parsed.description;
        lastMessage = parsed.lastMessage;
      } catch (err) {
        console.error(`[SubagentStop] transcript read failed:`, err);
      }
    }

    maps.subagentToolInputByUseId.delete(resolvedToolUseId);

    await callbacks.onSubagentStopped({
      agentId,
      agentType,
      toolUseId: resolvedToolUseId,
      description,
      lastMessage,
    });

    maps.agentIdToToolUseId.delete(agentId);

    return {};
  };
}
