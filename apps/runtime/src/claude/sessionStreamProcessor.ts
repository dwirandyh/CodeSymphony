import { readFileSync } from "node:fs";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeOwnershipDiagnostics, ClaudeToolInstrumentationEvent } from "../types.js";
import { appendRuntimeDebugLog } from "../routes/debug.js";

import { captureDiagnosticLine } from "./executableResolver.js";
import { isBashTool, skillNameFromUnknownToolInput } from "./toolClassification.js";
import type { ToolMetadata } from "./toolClassification.js";
import { completionSummaryFromMetadata } from "./toolSummary.js";
import { findDetectedPlanFile } from "./planFile.js";

import type { InstrumentContext, SessionMaps } from "./sessionInstrumentation.js";
import { buildFinishedTimingPreview, buildToolFinishedPayload } from "./sessionInstrumentation.js";
import {
  resolveCanonicalSubagentOwner,
  resolveSubagentIdentity,
  rememberSubagentOwner,
  type HookCallbacks,
  type SessionState,
} from "./sessionHooks.js";

type StreamProcessorDeps = {
  callbacks: HookCallbacks;
  emitInstrumentation: (event: ClaudeToolInstrumentationEvent) => Promise<void>;
  markStarted: (
    toolUseId: string,
    toolName: string,
    parentToolUseId: string | null,
    ownership: ClaudeOwnershipDiagnostics,
    startSource: "sdk.hook.pre_tool_use" | "sdk.stream.tool_progress",
    metadata?: ToolMetadata,
  ) => Promise<void>;
  maps: SessionMaps;
  instrumentContext: InstrumentContext;
  state: SessionState;
  permissionMode: string | undefined;
  onSessionId?: (sessionId: string) => Promise<void> | void;
  onText: (chunk: string) => Promise<void> | void;
  onToolOutput: (payload: {
    toolName: string;
    toolUseId: string;
    parentToolUseId: string | null;
    subagentOwnerToolUseId?: string | null;
    launcherToolUseId?: string | null;
    ownershipReason?: ClaudeOwnershipDiagnostics["ownershipReason"];
    ownershipCandidates?: string[];
    activeSubagentToolUseIds?: string[];
    elapsedTimeSeconds: number;
  }) => Promise<void> | void;
};

function ownershipFromToolUseId(maps: SessionMaps, toolUseId: string): ClaudeOwnershipDiagnostics {
  const requested = maps.requestedToolByUseId.get(toolUseId);
  return resolveCanonicalSubagentOwner(
    maps,
    {
      toolUseId,
      parentToolUseId: requested?.parentToolUseId ?? null,
      agentId: null,
    },
    { allowSingleActiveFallback: false },
  );
}

function logSummaryFallbackDecision(data: Record<string, unknown>): void {
  appendRuntimeDebugLog({
    source: "sessionStreamProcessor",
    message: "tool.summary.fallbackDecision",
    data,
  });
}

function buildSummaryToolUseIds(
  maps: SessionMaps,
  precedingToolUseIds: string[],
): {
  summaryToolUseIds: string[];
  skippedAmbiguousFallback: boolean;
  debug: Record<string, unknown>;
} {
  if (precedingToolUseIds.length > 0) {
    return {
      summaryToolUseIds: precedingToolUseIds,
      skippedAmbiguousFallback: false,
      debug: {
        decision: "sdk_preceding_ids",
        selectedToolUseIds: precedingToolUseIds,
      },
    };
  }

  const unresolvedStartedToolUseIds = Array.from(maps.startedToolUseIds)
    .filter((toolUseId) => !maps.finishedToolUseIds.has(toolUseId))
    .sort((left, right) => {
      const leftTimestamp = maps.startedAtMsByToolUseId.get(left)
        ?? maps.requestedToolByUseId.get(left)?.requestedAtMs
        ?? 0;
      const rightTimestamp = maps.startedAtMsByToolUseId.get(right)
        ?? maps.requestedToolByUseId.get(right)?.requestedAtMs
        ?? 0;
      return rightTimestamp - leftTimestamp;
    });

  if (unresolvedStartedToolUseIds.length <= 1) {
    return {
      summaryToolUseIds: unresolvedStartedToolUseIds,
      skippedAmbiguousFallback: false,
      debug: {
        decision: unresolvedStartedToolUseIds.length === 1 ? "single_unresolved_fallback" : "no_unresolved_tools",
        unresolvedStartedToolUseIds,
        selectedToolUseIds: unresolvedStartedToolUseIds,
      },
    };
  }

  const ownershipBuckets = new Map<string, string[]>();
  const unresolvedOwnership = unresolvedStartedToolUseIds.map((toolUseId) => {
    const ownership = ownershipFromToolUseId(maps, toolUseId);
    const bucketKey = ownership.subagentOwnerToolUseId
      ?? (ownership.ownershipReason === "unresolved_overlap_no_lineage"
        ? `overlap:${(ownership.activeSubagentToolUseIds ?? []).sort().join(",")}`
        : ownership.ownershipReason);
    const bucket = ownershipBuckets.get(bucketKey) ?? [];
    bucket.push(toolUseId);
    ownershipBuckets.set(bucketKey, bucket);
    return {
      toolUseId,
      ownershipReason: ownership.ownershipReason,
      subagentOwnerToolUseId: ownership.subagentOwnerToolUseId,
      ownershipCandidates: ownership.ownershipCandidates ?? [],
      activeSubagentToolUseIds: ownership.activeSubagentToolUseIds ?? [],
      bucketKey,
    };
  });

  const hasOverlapAmbiguity = unresolvedOwnership.some((entry) =>
    entry.ownershipReason === "unresolved_overlap_no_lineage"
    || entry.ownershipReason === "unresolved_ambiguous_candidates",
  );

  if (hasOverlapAmbiguity) {
    return {
      summaryToolUseIds: [],
      skippedAmbiguousFallback: true,
      debug: {
        decision: "skipped_overlap_ambiguous_fallback",
        unresolvedStartedToolUseIds,
        unresolvedOwnership,
        ownershipBuckets: [...ownershipBuckets.entries()].map(([bucketKey, toolUseIds]) => ({ bucketKey, toolUseIds })),
        selectedToolUseIds: [],
      },
    };
  }

  if (ownershipBuckets.size === 1) {
    return {
      summaryToolUseIds: unresolvedStartedToolUseIds,
      skippedAmbiguousFallback: false,
      debug: {
        decision: "single_bucket_fallback",
        unresolvedStartedToolUseIds,
        unresolvedOwnership,
        ownershipBuckets: [...ownershipBuckets.entries()].map(([bucketKey, toolUseIds]) => ({ bucketKey, toolUseIds })),
        selectedToolUseIds: unresolvedStartedToolUseIds,
      },
    };
  }

  return {
    summaryToolUseIds: [],
    skippedAmbiguousFallback: true,
    debug: {
      decision: "skipped_overlap_ambiguous_fallback",
      unresolvedStartedToolUseIds,
      unresolvedOwnership,
      ownershipBuckets: [...ownershipBuckets.entries()].map(([bucketKey, toolUseIds]) => ({ bucketKey, toolUseIds })),
      selectedToolUseIds: [],
    },
  };
}

function combineOwnership(maps: SessionMaps, toolUseIds: string[]): ClaudeOwnershipDiagnostics {
  const perToolOwnership = toolUseIds.map((toolUseId) => ownershipFromToolUseId(maps, toolUseId));
  if (perToolOwnership.length === 0) {
    return {
      subagentOwnerToolUseId: null,
      launcherToolUseId: null,
      ownershipReason: "unresolved_no_lineage",
    };
  }

  if (perToolOwnership.length === 1) {
    return perToolOwnership[0] as ClaudeOwnershipDiagnostics;
  }

  const ownerCandidates = new Set<string>();
  for (const ownership of perToolOwnership) {
    if (ownership.subagentOwnerToolUseId) {
      ownerCandidates.add(ownership.subagentOwnerToolUseId);
    }
    for (const candidate of ownership.ownershipCandidates ?? []) {
      ownerCandidates.add(candidate);
    }
  }

  if (ownerCandidates.size > 1) {
    return {
      subagentOwnerToolUseId: null,
      launcherToolUseId: null,
      ownershipReason: "unresolved_ambiguous_candidates",
      ownershipCandidates: [...ownerCandidates],
    };
  }

  const firstResolved = perToolOwnership.find((ownership) => ownership.subagentOwnerToolUseId);
  if (firstResolved?.subagentOwnerToolUseId) {
    return {
      subagentOwnerToolUseId: firstResolved.subagentOwnerToolUseId,
      launcherToolUseId: firstResolved.launcherToolUseId,
      ownershipReason: firstResolved.ownershipReason,
      ...(ownerCandidates.size > 0 ? { ownershipCandidates: [...ownerCandidates] } : {}),
    };
  }

  const ambiguous = perToolOwnership.find((ownership) => ownership.ownershipReason === "unresolved_ambiguous_candidates");
  if (ambiguous) {
    return {
      subagentOwnerToolUseId: null,
      launcherToolUseId: null,
      ownershipReason: "unresolved_ambiguous_candidates",
      ...(ambiguous.ownershipCandidates && ambiguous.ownershipCandidates.length > 0
        ? { ownershipCandidates: ambiguous.ownershipCandidates }
        : {}),
    };
  }

  return {
    subagentOwnerToolUseId: null,
    launcherToolUseId: null,
    ownershipReason: "unresolved_no_lineage",
  };
}

function ownershipPayload(ownership: ClaudeOwnershipDiagnostics): {
  subagentOwnerToolUseId?: string | null;
  launcherToolUseId?: string | null;
  ownershipReason?: ClaudeOwnershipDiagnostics["ownershipReason"];
  ownershipCandidates?: string[];
} {
  return {
    ...(ownership.subagentOwnerToolUseId !== null ? { subagentOwnerToolUseId: ownership.subagentOwnerToolUseId } : {}),
    ...(ownership.launcherToolUseId !== null ? { launcherToolUseId: ownership.launcherToolUseId } : {}),
    ...(ownership.ownershipReason !== "unresolved_no_lineage" ? { ownershipReason: ownership.ownershipReason } : {}),
    ...(ownership.ownershipCandidates && ownership.ownershipCandidates.length > 0
      ? { ownershipCandidates: ownership.ownershipCandidates }
      : {}),
    ...(ownership.activeSubagentToolUseIds && ownership.activeSubagentToolUseIds.length > 0
      ? { activeSubagentToolUseIds: ownership.activeSubagentToolUseIds }
      : {}),
  };
}

function extractSubagentResponse(
  maps: SessionMaps,
  toolUseIds: string[],
): string | undefined {
  for (const toolUseId of toolUseIds) {
    const response = maps.subagentResponseByUseId.get(toolUseId);
    if (response) {
      return response;
    }
  }
  return undefined;
}

function captureSystemDiagnostic(state: SessionState, message: SDKMessage): void {
  if (message.type !== "system") {
    return;
  }

  const systemMessage = message as unknown as {
    subtype?: string;
    attempt?: number;
    max_retries?: number;
    error_status?: number;
    error?: string;
    model?: string;
    apiKeySource?: string;
  };

  if (systemMessage.subtype === "api_retry") {
    captureDiagnosticLine(
      state.recentDiagnostics,
      `api_retry attempt ${systemMessage.attempt ?? "?"}/${systemMessage.max_retries ?? "?"}: status ${systemMessage.error_status ?? "unknown"} ${systemMessage.error ?? "unknown_error"}`,
    );
    return;
  }

  if (systemMessage.subtype === "init") {
    const details = [
      typeof systemMessage.model === "string" && systemMessage.model.length > 0 ? `model=${systemMessage.model}` : "",
      typeof systemMessage.apiKeySource === "string" && systemMessage.apiKeySource.length > 0
        ? `apiKeySource=${systemMessage.apiKeySource}`
        : "",
    ].filter(Boolean);
    if (details.length > 0) {
      captureDiagnosticLine(state.recentDiagnostics, `init: ${details.join(", ")}`);
    }
  }
}

function fatalSystemErrorFromMessage(message: SDKMessage): string | null {
  if (message.type !== "system") {
    return null;
  }

  const systemMessage = message as unknown as {
    subtype?: string;
    error?: string;
    error_status?: number;
  };

  if (systemMessage.subtype !== "api_retry" || typeof systemMessage.error !== "string") {
    return null;
  }

  if (/unknown provider for model/i.test(systemMessage.error)) {
    const status = systemMessage.error_status ?? 502;
    return `Claude API routing error (${status}): ${systemMessage.error}`;
  }

  return null;
}

export async function processStreamMessages(
  stream: AsyncIterable<SDKMessage>,
  deps: StreamProcessorDeps,
): Promise<string | null> {
  let latestSessionId: string | null = null;
  let sawToolUseSinceLastText = false;

  const {
    callbacks,
    emitInstrumentation,
    markStarted,
    maps,
    instrumentContext,
    state,
    onText,
    onToolOutput,
  } = deps;

  for await (const message of stream) {
    captureSystemDiagnostic(state, message);

    const fatalSystemError = fatalSystemErrorFromMessage(message);
    if (fatalSystemError) {
      throw new Error(fatalSystemError);
    }

    if (message.type === "system" && message.subtype === "init") {
      latestSessionId = message.session_id;
      if (typeof latestSessionId === "string" && latestSessionId.length > 0) {
        await deps.onSessionId?.(latestSessionId);
      }
      continue;
    }

    if (message.type === "stream_event") {
      const event = message.event;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (message.parent_tool_use_id) {
          continue;
        }
        if (sawToolUseSinceLastText && state.finalOutput.length > 0 && !/\s$/.test(state.finalOutput)) {
          state.finalOutput += "\n\n";
          await onText("\n\n");
        }
        sawToolUseSinceLastText = false;
        state.finalOutput += event.delta.text!;
        await onText(event.delta.text!);
      }
      continue;
    }

    if (message.type === "result") {
      state.resultSummary = {
        subtype: message.subtype,
        isError: message.is_error,
        durationMs: message.duration_ms,
        durationApiMs: message.duration_api_ms,
        totalCostUsd: message.total_cost_usd,
        stopReason: message.stop_reason,
        permissionDenialCount: message.permission_denials.length,
        errorCount: "errors" in message ? message.errors.length : 0,
      };
      if (message.is_error && "errors" in message && Array.isArray(message.errors) && message.errors.length > 0) {
        for (const error of message.errors) {
          const normalized = typeof error === "string" ? error : JSON.stringify(error);
          captureDiagnosticLine(state.recentDiagnostics, `result_error: ${normalized}`);
        }
      }
      if (message.subtype === "success" && state.finalOutput.trim().length === 0 && message.result.trim().length > 0) {
        state.finalOutput = message.result.trim();
      }
      continue;
    }

    if (message.type === "tool_progress") {
      sawToolUseSinceLastText = true;
      const msg = message;
      const metadata = maps.toolMetadataByUseId.get(msg.tool_use_id);
      maps.requestedToolByUseId.set(msg.tool_use_id, {
        toolName: msg.tool_name,
        parentToolUseId: msg.parent_tool_use_id,
        requestedAtMs: Date.now(),
      });
      if (!metadata) {
        maps.toolMetadataByUseId.set(msg.tool_use_id, {
          toolName: msg.tool_name,
          skillName: skillNameFromUnknownToolInput(msg.tool_name, null),
          isBash: isBashTool(msg.tool_name),
        });
      }

      const currentProgress = maps.progressByToolUseId.get(msg.tool_use_id) ?? {
        count: 0,
        maxElapsedTimeSeconds: 0,
      };
      currentProgress.count += 1;
      currentProgress.maxElapsedTimeSeconds = Math.max(
        currentProgress.maxElapsedTimeSeconds,
        msg.elapsed_time_seconds,
      );
      maps.progressByToolUseId.set(msg.tool_use_id, currentProgress);

      const ownership = resolveCanonicalSubagentOwner(
        maps,
        {
          toolUseId: msg.tool_use_id,
          parentToolUseId: msg.parent_tool_use_id,
          agentId: null,
        },
        { allowSingleActiveFallback: false },
      );
      const resolvedParentToolUseId = ownership.subagentOwnerToolUseId ?? msg.parent_tool_use_id;
      if (ownership.subagentOwnerToolUseId) {
        rememberSubagentOwner(maps, msg.tool_use_id, ownership.subagentOwnerToolUseId);
      }

      await markStarted(
        msg.tool_use_id,
        msg.tool_name,
        resolvedParentToolUseId,
        ownership,
        "sdk.stream.tool_progress",
        maps.toolMetadataByUseId.get(msg.tool_use_id),
      );

      await onToolOutput({
        toolName: msg.tool_name,
        toolUseId: msg.tool_use_id,
        parentToolUseId: resolvedParentToolUseId,
        subagentOwnerToolUseId: ownership.subagentOwnerToolUseId,
        launcherToolUseId: ownership.launcherToolUseId,
        ownershipReason: ownership.ownershipReason,
        ...(ownership.ownershipCandidates && ownership.ownershipCandidates.length > 0
          ? { ownershipCandidates: ownership.ownershipCandidates }
          : {}),
        ...(ownership.activeSubagentToolUseIds && ownership.activeSubagentToolUseIds.length > 0
          ? { activeSubagentToolUseIds: ownership.activeSubagentToolUseIds }
          : {}),
        elapsedTimeSeconds: msg.elapsed_time_seconds,
      });
      continue;
    }

    if (message.type === "tool_use_summary") {
      sawToolUseSinceLastText = true;
      const msg = message;
      const { summaryToolUseIds, skippedAmbiguousFallback, debug: summaryFallbackDebug } = buildSummaryToolUseIds(
        maps,
        msg.preceding_tool_use_ids,
      );
      logSummaryFallbackDecision({
        summary: typeof msg.summary === "string" ? msg.summary : "",
        ...summaryFallbackDebug,
      });

      if (skippedAmbiguousFallback) {
        await emitInstrumentation({
          stage: "anomaly",
          toolUseId: "tool_use_summary",
          toolName: "tool_use_summary",
          parentToolUseId: null,
          threadContext: instrumentContext,
          anomaly: {
            code: "summary_fallback_skipped_overlap",
            message: "Skipped tool_use_summary fallback because unresolved tools belonged to overlapping ownership buckets.",
            relatedToolUseIds: Array.isArray(summaryFallbackDebug.unresolvedStartedToolUseIds)
              ? summaryFallbackDebug.unresolvedStartedToolUseIds as string[]
              : [],
          },
        });
      }

      const pendingToolUseIds = summaryToolUseIds.filter((toolUseId) => !maps.finishedToolUseIds.has(toolUseId));
      for (const toolUseId of summaryToolUseIds) {
        if (!maps.toolMetadataByUseId.has(toolUseId)) {
          maps.summaryUnknownToolUseIds.add(toolUseId);
        }
      }
      const summaryText = typeof msg.summary === "string" ? msg.summary.trim() : "";

      // Capture Task tool summaries even when the tool is already finished (via PostToolUse hook).
      // This acts as a safety net: PostToolUse's extractSubagentResponse may fail for some
      // edge-case payloads, but the SDK's tool_use_summary always provides a reliable string.
      if (summaryText) {
        for (const toolUseId of summaryToolUseIds) {
          const metadata = maps.toolMetadataByUseId.get(toolUseId);
          if (metadata?.toolName?.toLowerCase() === "task" && !maps.subagentResponseByUseId.has(toolUseId)) {
            const subagentIdentity = resolveSubagentIdentity(
              maps,
              {
                toolUseId,
                parentToolUseId: null,
                agentId: null,
              },
              { allowSingleActiveFallback: false },
            );
            const responseOwnerToolUseId = subagentIdentity.subagentToolUseId;
            if (!responseOwnerToolUseId) {
              continue;
            }
            rememberSubagentOwner(maps, toolUseId, responseOwnerToolUseId);
            maps.subagentResponseByUseId.set(toolUseId, summaryText);
            maps.subagentResponseByUseId.set(responseOwnerToolUseId, summaryText);
            await callbacks.onSubagentStopped({
              agentId: "",
              agentType: "",
              toolUseId: responseOwnerToolUseId,
              description: "",
              lastMessage: summaryText,
              isResponseUpdate: true,
            });
          }
        }
      }

      if (pendingToolUseIds.length === 0) {
        for (const toolUseId of summaryToolUseIds) {
          maps.toolMetadataByUseId.delete(toolUseId);
          maps.bashResultByToolUseId.delete(toolUseId);
          maps.progressByToolUseId.delete(toolUseId);
        }
        continue;
      }

      const bashToolUseId = pendingToolUseIds.find((toolUseId) => maps.toolMetadataByUseId.get(toolUseId)?.isBash);
      const bashToolMetadata = bashToolUseId ? maps.toolMetadataByUseId.get(bashToolUseId) : undefined;
      const bashToolResult = bashToolUseId ? maps.bashResultByToolUseId.get(bashToolUseId) : undefined;
      const primaryToolMetadata = maps.toolMetadataByUseId.get(pendingToolUseIds[0] ?? "") ?? undefined;
      const editToolUseId = pendingToolUseIds.find((toolUseId) => {
        const editTarget = maps.toolMetadataByUseId.get(toolUseId)?.editTarget;
        return typeof editTarget === "string" && editTarget.length > 0;
      });
      const editTarget = editToolUseId ? maps.toolMetadataByUseId.get(editToolUseId)?.editTarget : undefined;
      let subagentSummaryOwnerToolUseId: string | null = null;
      const summaryOwnership = combineOwnership(maps, pendingToolUseIds);
      if (summaryOwnership.subagentOwnerToolUseId) {
        for (const toolUseId of pendingToolUseIds) {
          rememberSubagentOwner(maps, toolUseId, summaryOwnership.subagentOwnerToolUseId);
        }
      }
      logSummaryFallbackDecision({
        summary: summaryText,
        decision: "emit_summary_finish",
        pendingToolUseIds,
        ownershipReason: summaryOwnership.ownershipReason,
        ownershipCandidates: summaryOwnership.ownershipCandidates ?? [],
        activeSubagentToolUseIds: summaryOwnership.activeSubagentToolUseIds ?? [],
      });
      if (summaryText) {
        for (const toolUseId of pendingToolUseIds) {
          const metadata = maps.toolMetadataByUseId.get(toolUseId);
          if (metadata?.toolName?.toLowerCase() === "task") {
            const subagentIdentity = resolveSubagentIdentity(
              maps,
              {
                toolUseId,
                parentToolUseId: null,
                agentId: null,
              },
              { allowSingleActiveFallback: false },
            );
            subagentSummaryOwnerToolUseId = subagentIdentity.subagentToolUseId;
            if (!subagentSummaryOwnerToolUseId) {
              continue;
            }
            rememberSubagentOwner(maps, toolUseId, subagentSummaryOwnerToolUseId);
            maps.subagentResponseByUseId.set(toolUseId, summaryText);
            maps.subagentResponseByUseId.set(subagentSummaryOwnerToolUseId, summaryText);
            break;
          }
        }
      }
      const summarySubagentResponse = extractSubagentResponse(maps, pendingToolUseIds);

      for (const toolUseId of pendingToolUseIds) {
        maps.finishedToolUseIds.add(toolUseId);
      }
      await callbacks.onToolFinished({
        summary: msg.summary,
        precedingToolUseIds: pendingToolUseIds,
        ...(primaryToolMetadata?.toolName ? { toolName: primaryToolMetadata.toolName } : {}),
        ...(summarySubagentResponse
          ? { subagentResponse: summarySubagentResponse }
          : {}),
        ...ownershipPayload(summaryOwnership),
        ...(editTarget
          ? { editTarget }
          : {}),
        ...(bashToolMetadata?.isBash
          ? {
            command: bashToolMetadata.command,
            shell: "bash" as const,
            isBash: true as const,
            output: bashToolResult?.output,
            error: bashToolResult?.error,
            truncated: bashToolResult?.truncated ?? false,
            outputBytes: bashToolResult?.outputBytes ?? 0,
          }
          : primaryToolMetadata?.output !== undefined || primaryToolMetadata?.error !== undefined
            ? {
              output: primaryToolMetadata.output,
              error: primaryToolMetadata.error,
              truncated: primaryToolMetadata.truncated ?? false,
              outputBytes: primaryToolMetadata.outputBytes ?? 0,
            }
            : {}),
      });

      if (subagentSummaryOwnerToolUseId && summaryText) {
        await callbacks.onSubagentStopped({
          agentId: "",
          agentType: "",
          toolUseId: subagentSummaryOwnerToolUseId,
          description: "",
          lastMessage: summaryText,
          isResponseUpdate: true,
        });
      }

      const finishedAtMs = Date.now();
      for (const toolUseId of pendingToolUseIds) {
        const metadata = maps.toolMetadataByUseId.get(toolUseId);
        const { timing, preview } = buildFinishedTimingPreview(
          toolUseId,
          metadata ?? { toolName: "unknown", isBash: false },
          finishedAtMs,
          maps,
          bashToolMetadata?.isBash ? bashToolResult : undefined,
        );
        const ownership = ownershipFromToolUseId(maps, toolUseId);
        await emitInstrumentation({
          stage: "finished",
          toolUseId,
          toolName: metadata?.toolName ?? "unknown",
          parentToolUseId: ownership.subagentOwnerToolUseId
            ?? maps.requestedToolByUseId.get(toolUseId)?.parentToolUseId
            ?? null,
          summary: msg.summary,
          threadContext: instrumentContext,
          timing,
          preview,
        });
      }

      for (const toolUseId of summaryToolUseIds) {
        maps.toolMetadataByUseId.delete(toolUseId);
        maps.bashResultByToolUseId.delete(toolUseId);
        maps.progressByToolUseId.delete(toolUseId);
      }
      continue;
    }

    if (message.type === "system" && message.subtype === "files_persisted") {
      const files = message.files ?? [];
      for (const file of files) {
        if (file.filename.includes(".claude/plans/") && file.filename.endsWith(".md")) {
          maps.sessionPersistedPlanFiles.add(file.filename);
          try {
            const content = readFileSync(file.filename, "utf-8");
            if (content.trim().length > 0) {
              state.planFileDetected = true;
              await callbacks.onPlanFileDetected({ filePath: file.filename, content, source: "claude_plan_file" });
            }
          } catch {
            // Plan file could not be read; skip.
          }
        }
      }
      continue;
    }

    if (message.type === "assistant") {
      const textParts: string[] = [];

      for (const part of message.message.content) {
        if (part.type === "text") {
          textParts.push(part.text!);
        }
      }

      if (textParts.length > 0 && state.finalOutput.length === 0) {
        state.finalOutput = textParts.join("\n");
      }
    }
  }

  return latestSessionId;
}

export async function runPostStreamPlanDetection(
  state: SessionState,
  maps: SessionMaps,
  callbacks: HookCallbacks,
  permissionMode: string | undefined,
): Promise<void> {
  if (permissionMode !== "plan" || state.planFileDetected) {
    return;
  }

  const detectedPlan = findDetectedPlanFile(maps.sessionPersistedPlanFiles, state.queryStartTimestamp);
  if (detectedPlan) {
    await callbacks.onPlanFileDetected({ ...detectedPlan, source: "claude_plan_file" });
  }
}

export async function runSyntheticToolFinish(
  emitInstrumentation: (event: ClaudeToolInstrumentationEvent) => Promise<void>,
  callbacks: HookCallbacks,
  maps: SessionMaps,
  instrumentContext: InstrumentContext,
): Promise<void> {
  for (const toolUseId of maps.startedToolUseIds) {
    if (maps.finishedToolUseIds.has(toolUseId)) {
      continue;
    }

    const metadata = maps.toolMetadataByUseId.get(toolUseId) ?? {
      toolName: maps.requestedToolByUseId.get(toolUseId)?.toolName ?? "unknown",
      isBash: false,
    };
    const ownership = ownershipFromToolUseId(maps, toolUseId);
    if (ownership.subagentOwnerToolUseId) {
      rememberSubagentOwner(maps, toolUseId, ownership.subagentOwnerToolUseId);
    }
    const bashResult = maps.bashResultByToolUseId.get(toolUseId);
    const finishedAtMs = Date.now();
    const completionSummary = completionSummaryFromMetadata(metadata);
    await callbacks.onToolFinished({
      ...buildToolFinishedPayload(metadata, completionSummary, [toolUseId], bashResult),
      ...ownershipPayload(ownership),
    });
    const { timing, preview } = buildFinishedTimingPreview(toolUseId, metadata, finishedAtMs, maps, bashResult);
    await emitInstrumentation({
      stage: "finished",
      toolUseId,
      toolName: metadata.toolName,
      parentToolUseId: ownership.subagentOwnerToolUseId
        ?? maps.requestedToolByUseId.get(toolUseId)?.parentToolUseId
        ?? null,
      summary: completionSummary,
      threadContext: instrumentContext,
      timing,
      preview,
    });
    maps.finishedToolUseIds.add(toolUseId);
  }
}

export async function runAnomalyDetection(
  emitInstrumentation: (event: ClaudeToolInstrumentationEvent) => Promise<void>,
  maps: SessionMaps,
  instrumentContext: InstrumentContext,
): Promise<void> {
  for (const [toolUseId, requested] of maps.requestedToolByUseId.entries()) {
    const decision = maps.decisionByToolUseId.get(toolUseId);
    const shouldFlag = decision === "allow" || decision === "auto_allow";
    if (!shouldFlag || maps.startedToolUseIds.has(toolUseId)) {
      continue;
    }

    await emitInstrumentation({
      stage: "anomaly",
      toolUseId,
      toolName: requested.toolName,
      parentToolUseId: requested.parentToolUseId,
      threadContext: instrumentContext,
      anomaly: {
        code: "requested_not_started",
        message: "Tool was allowed but no start event was observed.",
      },
    });
  }

  for (const toolUseId of maps.startedToolUseIds) {
    if (maps.finishedToolUseIds.has(toolUseId)) {
      continue;
    }

    const metadata = maps.toolMetadataByUseId.get(toolUseId);
    await emitInstrumentation({
      stage: "anomaly",
      toolUseId,
      toolName: metadata?.toolName ?? maps.requestedToolByUseId.get(toolUseId)?.toolName ?? "unknown",
      parentToolUseId: maps.requestedToolByUseId.get(toolUseId)?.parentToolUseId ?? null,
      threadContext: instrumentContext,
      anomaly: {
        code: "started_not_finished",
        message: "Tool started but no finish event was observed.",
      },
    });
  }

  for (const toolUseId of maps.summaryUnknownToolUseIds) {
    await emitInstrumentation({
      stage: "anomaly",
      toolUseId,
      toolName: "unknown",
      parentToolUseId: null,
      threadContext: instrumentContext,
      anomaly: {
        code: "summary_unknown_tool",
        message: "Tool summary referenced an unknown tool use id.",
        relatedToolUseIds: [toolUseId],
      },
    });
  }
}
