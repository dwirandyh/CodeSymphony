import { readFileSync } from "node:fs";

import type { ClaudeToolInstrumentationDecision, ClaudeToolInstrumentationEvent } from "../types.js";
import { appendRuntimeDebugLog } from "../routes/debug.js";

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

function logSubagentDebug(message: string, data: Record<string, unknown>): void {
  appendRuntimeDebugLog({
    source: "sessionHooks",
    message,
    data,
  });
}

function isSubagentLauncherToolName(toolName: string | undefined | null): boolean {
  const normalized = (toolName ?? "").trim().toLowerCase();
  return normalized === "task" || normalized === "agent";
}

type SubagentOwnerResolution = {
  subagentOwnerToolUseId: string | null;
  launcherToolUseId: string | null;
};

type SubagentIdentity = {
  subagentToolUseId: string | null;
  taskToolUseId: string | null;
};

function normalizeToolUseId(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveSubagentOwnerFromCandidate(
  maps: SessionMaps,
  candidate: string | null,
): string | null {
  if (!candidate) {
    return null;
  }

  const knownOwner = maps.subagentOwnerToolUseIdByToolUseId.get(candidate);
  if (knownOwner) {
    return knownOwner;
  }

  const mappedFromTask = maps.subagentToolUseIdByTaskToolUseId.get(candidate);
  if (mappedFromTask) {
    return mappedFromTask;
  }

  if (maps.subagentTaskToolUseIdBySubagentToolUseId.has(candidate)) {
    return candidate;
  }

  if (maps.activeSubagentToolUseIds.includes(candidate)) {
    return candidate;
  }

  return null;
}

function resolveLauncherForSubagentOwner(
  maps: SessionMaps,
  subagentOwnerToolUseId: string,
): string | null {
  const activeLauncher = maps.subagentTaskToolUseIdBySubagentToolUseId.get(subagentOwnerToolUseId);
  if (activeLauncher) {
    return activeLauncher;
  }

  for (const [taskToolUseId, mappedSubagentToolUseId] of maps.subagentToolUseIdByTaskToolUseId.entries()) {
    if (mappedSubagentToolUseId === subagentOwnerToolUseId && taskToolUseId !== subagentOwnerToolUseId) {
      return taskToolUseId;
    }
  }

  return null;
}

export function resolveCanonicalSubagentOwner(
  maps: SessionMaps,
  params: {
    toolUseId?: string | null;
    parentToolUseId?: string | null;
    agentId?: string | null;
  },
): SubagentOwnerResolution {
  const rawToolUseId = normalizeToolUseId(params.toolUseId);
  const rawParentToolUseId = normalizeToolUseId(params.parentToolUseId);
  const rawAgentId = normalizeToolUseId(params.agentId);

  const candidates: Array<{ owner: string; launcher: string | null; source: string }> = [];

  const addOwnerCandidate = (owner: string | null, source: string): void => {
    if (!owner) {
      return;
    }

    candidates.push({
      owner,
      launcher: resolveLauncherForSubagentOwner(maps, owner),
      source,
    });
  };

  addOwnerCandidate(resolveSubagentOwnerFromCandidate(maps, rawToolUseId), "toolUseId");
  addOwnerCandidate(resolveSubagentOwnerFromCandidate(maps, rawParentToolUseId), "parentToolUseId");

  if (rawAgentId) {
    const mappedSubagentToolUseId = maps.agentIdToToolUseId.get(rawAgentId) ?? null;
    addOwnerCandidate(resolveSubagentOwnerFromCandidate(maps, mappedSubagentToolUseId), "agentId");
  }

  if (candidates.length === 0 && maps.activeSubagentToolUseIds.length === 1) {
    const onlyActiveOwner = maps.activeSubagentToolUseIds[0] ?? null;
    addOwnerCandidate(onlyActiveOwner, "singleActiveFallback");
  }

  if (candidates.length === 0) {
    return {
      subagentOwnerToolUseId: null,
      launcherToolUseId: null,
    };
  }

  const uniqueOwners = new Set(candidates.map((candidate) => candidate.owner));
  if (uniqueOwners.size > 1) {
    logSubagentDebug("subagent.ownerResolution.ambiguous", {
      toolUseId: rawToolUseId,
      parentToolUseId: rawParentToolUseId,
      agentId: rawAgentId,
      candidates,
      activeSubagentToolUseIds: [...maps.activeSubagentToolUseIds],
    });
    return {
      subagentOwnerToolUseId: null,
      launcherToolUseId: null,
    };
  }

  const resolved = candidates[0];
  if (!resolved) {
    return {
      subagentOwnerToolUseId: null,
      launcherToolUseId: null,
    };
  }

  return {
    subagentOwnerToolUseId: resolved.owner,
    launcherToolUseId: resolved.launcher,
  };
}

export function resolveSubagentIdentity(
  maps: SessionMaps,
  params: {
    toolUseId?: string | null;
    parentToolUseId?: string | null;
    agentId?: string | null;
  },
): SubagentIdentity {
  const owner = resolveCanonicalSubagentOwner(maps, params);
  if (!owner.subagentOwnerToolUseId) {
    return {
      subagentToolUseId: null,
      taskToolUseId: null,
    };
  }

  return {
    subagentToolUseId: owner.subagentOwnerToolUseId,
    taskToolUseId: owner.launcherToolUseId
      ?? resolveLauncherForSubagentOwner(maps, owner.subagentOwnerToolUseId),
  };
}

export function rememberSubagentOwner(
  maps: SessionMaps,
  toolUseId: string | null | undefined,
  ownerToolUseId: string,
): void {
  const normalizedToolUseId = normalizeToolUseId(toolUseId);
  const normalizedOwnerToolUseId = normalizeToolUseId(ownerToolUseId);
  if (!normalizedToolUseId || !normalizedOwnerToolUseId) {
    return;
  }

  const existingOwner = maps.subagentOwnerToolUseIdByToolUseId.get(normalizedToolUseId);
  if (existingOwner && existingOwner !== normalizedOwnerToolUseId) {
    logSubagentDebug("subagent.ownerMapping.conflict", {
      toolUseId: normalizedToolUseId,
      existingOwner,
      nextOwner: normalizedOwnerToolUseId,
    });
    return;
  }

  maps.subagentOwnerToolUseIdByToolUseId.set(normalizedToolUseId, normalizedOwnerToolUseId);
}

function rememberSubagentTaskBridge(
  maps: SessionMaps,
  taskToolUseId: string | null | undefined,
  subagentToolUseId: string | null | undefined,
): void {
  const normalizedTaskToolUseId = normalizeToolUseId(taskToolUseId);
  const normalizedSubagentToolUseId = normalizeToolUseId(subagentToolUseId);
  if (!normalizedTaskToolUseId || !normalizedSubagentToolUseId) {
    return;
  }

  const existingSubagentToolUseId = maps.subagentToolUseIdByTaskToolUseId.get(normalizedTaskToolUseId);
  if (existingSubagentToolUseId && existingSubagentToolUseId !== normalizedSubagentToolUseId) {
    logSubagentDebug("subagent.taskBridge.conflict", {
      taskToolUseId: normalizedTaskToolUseId,
      existingSubagentToolUseId,
      nextSubagentToolUseId: normalizedSubagentToolUseId,
    });
    return;
  }

  maps.subagentToolUseIdByTaskToolUseId.set(normalizedTaskToolUseId, normalizedSubagentToolUseId);
  rememberSubagentOwner(maps, normalizedTaskToolUseId, normalizedSubagentToolUseId);
  rememberSubagentOwner(maps, normalizedSubagentToolUseId, normalizedSubagentToolUseId);
}

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
    subagentOwnerToolUseId: string | null;
    launcherToolUseId: string | null;
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
      agentID?: string;
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
    if (isSubagentLauncherToolName(toolName)) {
      maps.pendingSubagentTaskToolUseIds.push(toolUseId);
    }

    const canonicalRequestOwner = resolveCanonicalSubagentOwner(maps, {
      toolUseId,
      parentToolUseId: null,
      agentId: options.agentID ?? null,
    });
    if (canonicalRequestOwner.subagentOwnerToolUseId) {
      rememberSubagentOwner(maps, toolUseId, canonicalRequestOwner.subagentOwnerToolUseId);
      if (canonicalRequestOwner.launcherToolUseId) {
        rememberSubagentTaskBridge(
          maps,
          canonicalRequestOwner.launcherToolUseId,
          canonicalRequestOwner.subagentOwnerToolUseId,
        );
      }
    }

    const activeSubagentToolUseId = maps.activeSubagentToolUseIds[maps.activeSubagentToolUseIds.length - 1] ?? null;
    const permissionParentToolUseId = canonicalRequestOwner.subagentOwnerToolUseId ?? activeSubagentToolUseId;
    maps.requestedToolByUseId.set(toolUseId, {
      toolName,
      parentToolUseId: permissionParentToolUseId,
      requestedAtMs: nowMs,
    });
    await emitInstrumentation({
      stage: "requested",
      toolUseId,
      toolName,
      parentToolUseId: permissionParentToolUseId,
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
      await emitDecision(toolUseId, "plan_deny", toolName, permissionParentToolUseId, {
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
      await emitDecision(toolUseId, "allow", toolName, permissionParentToolUseId, {
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
      await emitDecision(toolUseId, "auto_allow", toolName, permissionParentToolUseId, {
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
      await emitDecision(toolUseId, "allow", toolName, permissionParentToolUseId, {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
      });
      return {
        behavior: "allow" as const,
        updatedInput: input,
      };
    }

    if (autoAcceptTools) {
      await emitDecision(toolUseId, "auto_allow", toolName, permissionParentToolUseId, {
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

    const permissionOwner = resolveCanonicalSubagentOwner(maps, {
      toolUseId,
      parentToolUseId: permissionParentToolUseId,
      agentId: options.agentID ?? null,
    });
    const resolvedPermissionParentToolUseId = permissionOwner.subagentOwnerToolUseId ?? permissionParentToolUseId;
    if (permissionOwner.subagentOwnerToolUseId) {
      rememberSubagentOwner(maps, toolUseId, permissionOwner.subagentOwnerToolUseId);
      if (permissionOwner.launcherToolUseId) {
        rememberSubagentTaskBridge(
          maps,
          permissionOwner.launcherToolUseId,
          permissionOwner.subagentOwnerToolUseId,
        );
      }
    }

    const decision = await callbacks.onPermissionRequest({
      requestId: toolUseId,
      toolName,
      toolInput: input,
      blockedPath: options.blockedPath ?? null,
      decisionReason: options.decisionReason ?? null,
      suggestions: options.suggestions ?? null,
      subagentOwnerToolUseId: permissionOwner.subagentOwnerToolUseId,
      launcherToolUseId: permissionOwner.launcherToolUseId,
    });

    if (decision.decision === "allow") {
      await emitDecision(toolUseId, "allow", toolName, resolvedPermissionParentToolUseId, {
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

    await emitDecision(toolUseId, "deny", toolName, resolvedPermissionParentToolUseId, {
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
    const resolvedIdentity = resolveSubagentIdentity(maps, {
      toolUseId: hookToolUseId,
      parentToolUseId: null,
      agentId: null,
    });
    const inferredParentToolUseId = resolvedIdentity.subagentToolUseId
      ?? maps.activeSubagentToolUseIds[maps.activeSubagentToolUseIds.length - 1]
      ?? null;
    if (resolvedIdentity.subagentToolUseId) {
      rememberSubagentOwner(maps, hookToolUseId, resolvedIdentity.subagentToolUseId);
    }
    maps.toolMetadataByUseId.set(hookToolUseId, {
      toolName: hookInput.tool_name as string,
      command,
      readTarget: readTargetFromUnknownToolInput(hookInput.tool_name as string, hookInput.tool_input),
      searchParams: searchParamsFromUnknownToolInput(hookInput.tool_name as string, hookInput.tool_input),
      isBash: isBashTool(hookInput.tool_name as string),
    });
    maps.requestedToolByUseId.set(hookToolUseId, {
      toolName: hookInput.tool_name as string,
      parentToolUseId: inferredParentToolUseId,
      requestedAtMs: Date.now(),
    });

    await markStarted(
      hookToolUseId,
      hookInput.tool_name as string,
      inferredParentToolUseId,
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

    if (isSubagentLauncherToolName(hookInput.tool_name as string)) {
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
      const subagentIdentity = resolveSubagentIdentity(maps, {
        toolUseId: hookToolUseId,
        parentToolUseId: null,
        agentId: null,
      });
      const responseOwnerToolUseId = subagentIdentity.subagentToolUseId ?? hookToolUseId;
      if (subagentIdentity.subagentToolUseId) {
        rememberSubagentOwner(maps, hookToolUseId, subagentIdentity.subagentToolUseId);
      }
      logSubagentDebug("subagent.postToolUse.lateResponseUpdate", {
        toolUseId: hookToolUseId,
        responseOwnerToolUseId,
        responseLength: capturedResponse.length,
      });
      await callbacks.onSubagentStopped({
        agentId: "",
        agentType: "",
        toolUseId: responseOwnerToolUseId,
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

    const isKnownTaskToolUseId = (candidateToolUseId: string): boolean => {
      const metadata = maps.toolMetadataByUseId.get(candidateToolUseId);
      if (isSubagentLauncherToolName(metadata?.toolName)) {
        return true;
      }
      const requested = maps.requestedToolByUseId.get(candidateToolUseId);
      return isSubagentLauncherToolName(requested?.toolName);
    };

    const agentId = String(hookInput.agent_id ?? "");
    const agentType = String(hookInput.agent_type ?? "unknown");
    const subagentToolUseId = String(hookInput.tool_use_id || toolUseID || "");
    const parentToolUseId = String(hookInput.parent_tool_use_id ?? "");

    let taskToolUseId = "";

    if (subagentToolUseId) {
      taskToolUseId = maps.subagentTaskToolUseIdBySubagentToolUseId.get(subagentToolUseId) ?? "";
      if (!taskToolUseId && maps.subagentToolInputByUseId.has(subagentToolUseId) && isKnownTaskToolUseId(subagentToolUseId)) {
        taskToolUseId = subagentToolUseId;
      }
    }

    if (!taskToolUseId && parentToolUseId && maps.subagentToolInputByUseId.has(parentToolUseId) && isKnownTaskToolUseId(parentToolUseId)) {
      taskToolUseId = parentToolUseId;
    }

    if (!taskToolUseId) {
      const assignedTaskToolUseIds = new Set(maps.subagentTaskToolUseIdBySubagentToolUseId.values());
      while (maps.pendingSubagentTaskToolUseIds.length > 0) {
        const candidateTaskToolUseId = maps.pendingSubagentTaskToolUseIds.shift();
        if (!candidateTaskToolUseId) {
          break;
        }
        if (!maps.subagentToolInputByUseId.has(candidateTaskToolUseId)) {
          continue;
        }
        if (assignedTaskToolUseIds.has(candidateTaskToolUseId)) {
          continue;
        }
        const candidateDecision = maps.decisionByToolUseId.get(candidateTaskToolUseId);
        if (candidateDecision === "deny" || candidateDecision === "plan_deny") {
          continue;
        }
        taskToolUseId = candidateTaskToolUseId;
        break;
      }
    }

    if (subagentToolUseId && taskToolUseId) {
      maps.subagentTaskToolUseIdBySubagentToolUseId.set(subagentToolUseId, taskToolUseId);
      rememberSubagentTaskBridge(maps, taskToolUseId, subagentToolUseId);
    }

    if (agentId && subagentToolUseId) {
      maps.agentIdToToolUseId.set(agentId, subagentToolUseId);
    }

    if (subagentToolUseId) {
      rememberSubagentOwner(maps, subagentToolUseId, subagentToolUseId);
      if (taskToolUseId) {
        rememberSubagentOwner(maps, taskToolUseId, subagentToolUseId);
      }
      if (parentToolUseId) {
        rememberSubagentOwner(maps, parentToolUseId, subagentToolUseId);
      }
    }

    const toolInput = taskToolUseId
      ? maps.subagentToolInputByUseId.get(taskToolUseId)
      : undefined;
    if (subagentToolUseId && taskToolUseId && toolInput && !maps.subagentToolInputByUseId.has(subagentToolUseId)) {
      maps.subagentToolInputByUseId.set(subagentToolUseId, toolInput);
    }
    const description = toolInput
      ? String((toolInput as Record<string, unknown>).description
        ?? (toolInput as Record<string, unknown>).prompt
        ?? (toolInput as Record<string, unknown>).task
        ?? (toolInput as Record<string, unknown>).Task
        ?? "")
      : "";

    logSubagentDebug("subagent.start.mapping", {
      agentId,
      agentType,
      subagentToolUseId,
      parentToolUseId,
      taskToolUseId,
      mappingSource: subagentToolUseId && taskToolUseId && subagentToolUseId === taskToolUseId
        ? "subagentToolUseId"
        : parentToolUseId && taskToolUseId && parentToolUseId === taskToolUseId
          ? "parentToolUseId"
          : taskToolUseId
            ? "pendingTaskFallback"
            : "none",
      descriptionLength: description.length,
      pendingTaskQueueLength: maps.pendingSubagentTaskToolUseIds.length,
    });

    if (subagentToolUseId) {
      maps.activeSubagentToolUseIds.push(subagentToolUseId);
    }

    await callbacks.onSubagentStarted({
      agentId,
      agentType,
      toolUseId: subagentToolUseId,
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
    const subagentToolUseId = maps.agentIdToToolUseId.get(agentId)
      ?? String(hookInput.tool_use_id || toolUseID || "");
    const bridgedTaskToolUseId = subagentToolUseId
      ? maps.subagentTaskToolUseIdBySubagentToolUseId.get(subagentToolUseId) ?? ""
      : "";
    const taskToolUseId = bridgedTaskToolUseId
      || (subagentToolUseId && maps.subagentToolInputByUseId.has(subagentToolUseId)
        ? subagentToolUseId
        : "");

    let description = "";
    let lastMessage = "";
    const transcriptPath = String(hookInput.agent_transcript_path ?? "");
    if (transcriptPath) {
      try {
        const transcriptContent = readFileSync(transcriptPath, "utf-8");
        const parsed = parseSubagentTranscript(transcriptContent);
        description = parsed.description;
        lastMessage = parsed.lastMessage;
        logSubagentDebug("subagent.stop.transcriptParsed", {
          agentId,
          agentType,
          subagentToolUseId,
          bridgedTaskToolUseId,
          transcriptPath,
          transcriptReadSuccess: true,
          parsedDescriptionLength: description.length,
          parsedLastMessageLength: lastMessage.length,
        });
      } catch (err) {
        logSubagentDebug("subagent.stop.transcriptParsed", {
          agentId,
          agentType,
          subagentToolUseId,
          bridgedTaskToolUseId,
          transcriptPath,
          transcriptReadSuccess: false,
          error: err instanceof Error ? err.message : String(err),
        });
        console.error(`[SubagentStop] transcript read failed:`, err);
      }
    } else {
      logSubagentDebug("subagent.stop.transcriptParsed", {
        agentId,
        agentType,
        subagentToolUseId,
        bridgedTaskToolUseId,
        transcriptPath: null,
        transcriptReadSuccess: false,
        reason: "missing_path",
      });
    }

    if (subagentToolUseId) {
      rememberSubagentOwner(maps, subagentToolUseId, subagentToolUseId);
      maps.subagentTaskToolUseIdBySubagentToolUseId.delete(subagentToolUseId);
      if (subagentToolUseId !== taskToolUseId) {
        maps.subagentToolInputByUseId.delete(subagentToolUseId);
      }
    }

    if (taskToolUseId) {
      if (subagentToolUseId) {
        rememberSubagentTaskBridge(maps, taskToolUseId, subagentToolUseId);
      }
      maps.subagentToolInputByUseId.delete(taskToolUseId);
      maps.pendingSubagentTaskToolUseIds = maps.pendingSubagentTaskToolUseIds.filter((id) => id !== taskToolUseId);
    }

    logSubagentDebug("subagent.stop.finalPayload", {
      agentId,
      agentType,
      subagentToolUseId,
      taskToolUseId,
      descriptionLength: description.length,
      lastMessageLength: lastMessage.length,
    });

    await callbacks.onSubagentStopped({
      agentId,
      agentType,
      toolUseId: subagentToolUseId,
      description,
      lastMessage,
    });

    maps.agentIdToToolUseId.delete(agentId);
    maps.activeSubagentToolUseIds = maps.activeSubagentToolUseIds.filter((id) => id !== subagentToolUseId);

    return {};
  };
}
