import type { ChatMode, ChatThreadPermissionProfile } from "@codesymphony/shared-types";
import type {
  ClaudeOwnershipDiagnostics,
  ClaudeToolInstrumentationDecision,
  ClaudeToolInstrumentationEvent,
} from "../types.js";

import { sanitizeForLog, truncateForPreview, toIso } from "./sanitize.js";
import {
  commandFromUnknownToolInput,
  readTargetFromUnknownToolInput,
  searchParamsFromUnknownToolInput,
  editTargetFromUnknownToolInput,
  skillNameFromUnknownToolInput,
  isBashTool,
  type ToolMetadata,
} from "./toolClassification.js";
import type { BashToolResult } from "./bashResult.js";

export type InstrumentContext = {
  cwd: string;
  sessionId: string | null;
  permissionMode: ChatMode;
  autoAcceptTools: boolean;
  permissionProfile: ChatThreadPermissionProfile;
};

export type SessionMaps = {
  startedToolUseIds: Set<string>;
  finishedToolUseIds: Set<string>;
  toolMetadataByUseId: Map<string, ToolMetadata>;
  bashResultByToolUseId: Map<string, BashToolResult>;
  requestedToolByUseId: Map<string, { toolName: string; parentToolUseId: string | null; requestedAtMs: number }>;
  agentIdToToolUseId: Map<string, string>;
  decisionByToolUseId: Map<string, ClaudeToolInstrumentationDecision>;
  startedAtMsByToolUseId: Map<string, number>;
  progressByToolUseId: Map<string, { count: number; maxElapsedTimeSeconds: number }>;
  summaryUnknownToolUseIds: Set<string>;
  subagentToolInputByUseId: Map<string, Record<string, unknown>>;
  pendingSubagentTaskToolUseIds: string[];
  subagentTaskToolUseIdBySubagentToolUseId: Map<string, string>;
  subagentToolUseIdByTaskToolUseId: Map<string, string>;
  subagentOwnerToolUseIdByToolUseId: Map<string, string>;
  subagentResponseByUseId: Map<string, string>;
  sessionPersistedPlanFiles: Set<string>;
  activeSubagentToolUseIds: string[];
  ownershipDebugLogCache: Set<string>;
};

export function createEmitInstrumentation(
  onToolInstrumentation: ((event: ClaudeToolInstrumentationEvent) => Promise<void> | void) | undefined,
) {
  return async function emitInstrumentation(event: ClaudeToolInstrumentationEvent): Promise<void> {
    if (!onToolInstrumentation) {
      return;
    }

    try {
      await onToolInstrumentation(event);
    } catch {
      // Instrumentation must never break the Claude stream.
    }
  };
}

export function createEmitDecision(
  emitInstrumentation: (event: ClaudeToolInstrumentationEvent) => Promise<void>,
  maps: SessionMaps,
  instrumentContext: InstrumentContext,
) {
  return async function emitDecision(
    toolUseId: string,
    decision: ClaudeToolInstrumentationDecision,
    toolName: string,
    parentToolUseId: string | null,
    preview: ClaudeToolInstrumentationEvent["preview"],
  ): Promise<void> {
    maps.decisionByToolUseId.set(toolUseId, decision);
    await emitInstrumentation({
      stage: "decision",
      toolUseId,
      toolName,
      parentToolUseId,
      decision,
      threadContext: instrumentContext,
      preview,
    });
  };
}

export function createMarkStarted(
  onToolStarted: (payload: {
    toolName: string;
    toolUseId: string;
    parentToolUseId: string | null;
    subagentOwnerToolUseId?: string | null;
    launcherToolUseId?: string | null;
    ownershipReason?: ClaudeOwnershipDiagnostics["ownershipReason"];
    ownershipCandidates?: string[];
    activeSubagentToolUseIds?: string[];
    command?: string;
    searchParams?: string;
    editTarget?: string;
    skillName?: string;
    shell?: "bash";
    isBash?: true;
  }) => Promise<void> | void,
  emitInstrumentation: (event: ClaudeToolInstrumentationEvent) => Promise<void>,
  maps: SessionMaps,
  instrumentContext: InstrumentContext,
) {
  return async function markStarted(
    toolUseId: string,
    toolName: string,
    parentToolUseId: string | null,
    ownership: ClaudeOwnershipDiagnostics,
    startSource: "sdk.hook.pre_tool_use" | "sdk.stream.tool_progress",
    metadata?: ToolMetadata,
  ): Promise<void> {
    if (maps.startedToolUseIds.has(toolUseId)) {
      return;
    }

    maps.startedToolUseIds.add(toolUseId);
    const startedAtMs = Date.now();
    maps.startedAtMsByToolUseId.set(toolUseId, startedAtMs);
    await onToolStarted({
      toolName,
      toolUseId,
      parentToolUseId,
      subagentOwnerToolUseId: ownership.subagentOwnerToolUseId,
      launcherToolUseId: ownership.launcherToolUseId,
      ownershipReason: ownership.ownershipReason,
      ...(ownership.ownershipCandidates && ownership.ownershipCandidates.length > 0
        ? { ownershipCandidates: ownership.ownershipCandidates }
        : {}),
      ...(ownership.activeSubagentToolUseIds && ownership.activeSubagentToolUseIds.length > 0
        ? { activeSubagentToolUseIds: ownership.activeSubagentToolUseIds }
        : {}),
      ...(metadata?.editTarget
        ? {
          editTarget: metadata.editTarget,
        }
        : {}),
      ...(metadata?.skillName
        ? {
          skillName: metadata.skillName,
        }
        : {}),
      ...(metadata?.isBash
        ? {
          command: metadata.command,
          shell: "bash" as const,
          isBash: true as const,
        }
        : metadata?.searchParams
          ? {
            searchParams: metadata.searchParams,
          }
          : {}),
    });
    await emitInstrumentation({
      stage: "started",
      toolUseId,
      toolName,
      parentToolUseId,
      threadContext: instrumentContext,
      timing: {
        startedAt: toIso(startedAtMs),
      },
      preview: {
        ...(metadata?.command ? { command: metadata.command } : {}),
        startSource,
      },
    });
  };
}

export function buildMetadataFromHookInput(
  hookInput: Record<string, unknown>,
  hookToolUseId: string,
  toolMetadataByUseId: Map<string, ToolMetadata>,
): ToolMetadata {
  const existing = toolMetadataByUseId.get(hookToolUseId);
  const metadata: ToolMetadata = existing ?? {
    toolName: hookInput.tool_name as string,
    command: commandFromUnknownToolInput(hookInput.tool_input),
    readTarget: readTargetFromUnknownToolInput(hookInput.tool_name as string, hookInput.tool_input),
    searchParams: searchParamsFromUnknownToolInput(hookInput.tool_name as string, hookInput.tool_input),
    editTarget: editTargetFromUnknownToolInput(hookInput.tool_name as string, hookInput.tool_input),
    skillName: skillNameFromUnknownToolInput(hookInput.tool_name as string, hookInput.tool_input),
    isBash: isBashTool(hookInput.tool_name as string),
  };
  if (!metadata.readTarget) {
    metadata.readTarget = readTargetFromUnknownToolInput(metadata.toolName, hookInput.tool_input);
  }
  if (!metadata.searchParams) {
    metadata.searchParams = searchParamsFromUnknownToolInput(metadata.toolName, hookInput.tool_input);
  }
  if (!metadata.editTarget) {
    metadata.editTarget = editTargetFromUnknownToolInput(metadata.toolName, hookInput.tool_input);
  }
  if (!metadata.skillName) {
    metadata.skillName = skillNameFromUnknownToolInput(metadata.toolName, hookInput.tool_input);
  }
  toolMetadataByUseId.set(hookToolUseId, metadata);
  return metadata;
}

export function buildFinishedTimingPreview(
  toolUseId: string,
  metadata: ToolMetadata,
  finishedAtMs: number,
  maps: SessionMaps,
  bashResult?: BashToolResult,
  hookToolResponse?: unknown,
) {
  const progress = maps.progressByToolUseId.get(toolUseId);
  const startedAtMs = maps.startedAtMsByToolUseId.get(toolUseId);
  return {
    timing: {
      progressCount: progress?.count ?? 0,
      maxElapsedTimeSeconds: progress?.maxElapsedTimeSeconds ?? 0,
      ...(startedAtMs
        ? {
          startedAt: toIso(startedAtMs),
          durationMs: finishedAtMs - startedAtMs,
        }
        : {}),
      finishedAt: toIso(finishedAtMs),
    },
    preview: {
      ...(metadata.command ? { command: metadata.command } : {}),
      ...(metadata.isBash
        ? {
          output: sanitizeForLog(bashResult?.output) as string | undefined,
          error: sanitizeForLog(bashResult?.error) as string | undefined,
          truncated: bashResult?.truncated ?? false,
          outputBytes: bashResult?.outputBytes ?? 0,
        }
        : {
          output: typeof hookToolResponse === "string"
            ? truncateForPreview(hookToolResponse)
            : undefined,
        }),
    },
  };
}

export function buildToolFinishedPayload(
  metadata: ToolMetadata,
  summary: string,
  toolUseIds: string[],
  bashResult?: BashToolResult,
  subagentResponse?: string,
) {
  const resolvedOutput = metadata.isBash ? bashResult?.output : metadata.output;
  const resolvedError = metadata.isBash ? bashResult?.error : metadata.error;
  const resolvedTruncated = metadata.isBash ? (bashResult?.truncated ?? false) : (metadata.truncated ?? false);
  const resolvedOutputBytes = metadata.isBash ? (bashResult?.outputBytes ?? 0) : (metadata.outputBytes ?? 0);

  return {
    summary,
    precedingToolUseIds: toolUseIds,
    toolName: metadata.toolName,
    ...(subagentResponse ? { subagentResponse } : {}),
    ...(metadata.skillName ? { skillName: metadata.skillName } : {}),
    ...(metadata.editTarget
      ? { editTarget: metadata.editTarget }
      : {}),
    ...(metadata.isBash
      ? {
        command: metadata.command,
        shell: "bash" as const,
        isBash: true as const,
      }
      : metadata.searchParams
        ? { searchParams: metadata.searchParams }
        : {}),
    ...(resolvedOutput !== undefined ? { output: resolvedOutput } : {}),
    ...(resolvedError !== undefined ? { error: resolvedError } : {}),
    ...(resolvedOutput !== undefined || resolvedError !== undefined
      ? {
        truncated: resolvedTruncated,
        outputBytes: resolvedOutputBytes,
      }
      : {}),
  };
}
