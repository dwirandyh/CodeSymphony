import { readFileSync } from "node:fs";

import type { ClaudeToolInstrumentationEvent } from "../types.js";

import { isBashTool } from "./toolClassification.js";
import type { ToolMetadata } from "./toolClassification.js";
import { completionSummaryFromMetadata } from "./toolSummary.js";
import { findLatestPlanFile } from "./planFile.js";

import type { InstrumentContext, SessionMaps } from "./sessionInstrumentation.js";
import { buildFinishedTimingPreview, buildToolFinishedPayload } from "./sessionInstrumentation.js";
import type { HookCallbacks, SessionState } from "./sessionHooks.js";

export type StreamProcessorDeps = {
  callbacks: HookCallbacks;
  emitInstrumentation: (event: ClaudeToolInstrumentationEvent) => Promise<void>;
  markStarted: (
    toolUseId: string,
    toolName: string,
    parentToolUseId: string | null,
    startSource: "sdk.hook.pre_tool_use" | "sdk.stream.tool_progress",
    metadata?: ToolMetadata,
  ) => Promise<void>;
  maps: SessionMaps;
  instrumentContext: InstrumentContext;
  state: SessionState;
  permissionMode: string | undefined;
  onText: (chunk: string) => Promise<void> | void;
  onThinking: (chunk: string) => Promise<void> | void;
  onToolOutput: (payload: {
    toolName: string;
    toolUseId: string;
    parentToolUseId: string | null;
    elapsedTimeSeconds: number;
  }) => Promise<void> | void;
};

export async function processStreamMessages(
  stream: AsyncIterable<Record<string, unknown>>,
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
    onThinking,
    onToolOutput,
  } = deps;

  for await (const message of stream) {
    if ((message as { type: string }).type === "system" && (message as { subtype?: string }).subtype === "init") {
      latestSessionId = (message as { session_id: string }).session_id;
      continue;
    }

    if ((message as { type: string }).type === "stream_event") {
      const event = (message as { event: { type: string; delta: { type: string; text?: string; thinking?: string } } }).event;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if ((message as { parent_tool_use_id?: string }).parent_tool_use_id) {
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
      if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
        if (!(message as { parent_tool_use_id?: string }).parent_tool_use_id) {
          await onThinking(event.delta.thinking!);
        }
      }
      continue;
    }

    if ((message as { type: string }).type === "tool_progress") {
      sawToolUseSinceLastText = true;
      const msg = message as {
        tool_use_id: string;
        tool_name: string;
        parent_tool_use_id: string | null;
        elapsed_time_seconds: number;
      };
      const metadata = maps.toolMetadataByUseId.get(msg.tool_use_id);
      maps.requestedToolByUseId.set(msg.tool_use_id, {
        toolName: msg.tool_name,
        parentToolUseId: msg.parent_tool_use_id,
        requestedAtMs: Date.now(),
      });
      if (!metadata) {
        maps.toolMetadataByUseId.set(msg.tool_use_id, {
          toolName: msg.tool_name,
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

      await markStarted(
        msg.tool_use_id,
        msg.tool_name,
        msg.parent_tool_use_id,
        "sdk.stream.tool_progress",
        maps.toolMetadataByUseId.get(msg.tool_use_id),
      );

      await onToolOutput({
        toolName: msg.tool_name,
        toolUseId: msg.tool_use_id,
        parentToolUseId: msg.parent_tool_use_id,
        elapsedTimeSeconds: msg.elapsed_time_seconds,
      });
      continue;
    }

    if ((message as { type: string }).type === "tool_use_summary") {
      sawToolUseSinceLastText = true;
      const msg = message as {
        preceding_tool_use_ids: string[];
        summary: string;
      };
      const unresolvedStartedToolUseIds = Array.from(maps.startedToolUseIds).filter((toolUseId) => !maps.finishedToolUseIds.has(toolUseId));
      const summaryToolUseIds = msg.preceding_tool_use_ids.length > 0
        ? msg.preceding_tool_use_ids
        : unresolvedStartedToolUseIds
          .sort((left, right) => {
            const leftTimestamp = maps.startedAtMsByToolUseId.get(left)
              ?? maps.requestedToolByUseId.get(left)?.requestedAtMs
              ?? 0;
            const rightTimestamp = maps.startedAtMsByToolUseId.get(right)
              ?? maps.requestedToolByUseId.get(right)?.requestedAtMs
              ?? 0;
            return rightTimestamp - leftTimestamp;
          })
          .slice(0, 1);

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
            maps.subagentResponseByUseId.set(toolUseId, summaryText);
            await callbacks.onSubagentStopped({
              agentId: "",
              agentType: "",
              toolUseId,
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
      const editToolUseId = pendingToolUseIds.find((toolUseId) => {
        const editTarget = maps.toolMetadataByUseId.get(toolUseId)?.editTarget;
        return typeof editTarget === "string" && editTarget.length > 0;
      });
      const editTarget = editToolUseId ? maps.toolMetadataByUseId.get(editToolUseId)?.editTarget : undefined;
      let subagentTaskToolUseId: string | null = null;
      if (summaryText) {
        for (const toolUseId of pendingToolUseIds) {
          const metadata = maps.toolMetadataByUseId.get(toolUseId);
          if (metadata?.toolName?.toLowerCase() === "task") {
            maps.subagentResponseByUseId.set(toolUseId, summaryText);
            subagentTaskToolUseId = toolUseId;
            break;
          }
        }
      }

      for (const toolUseId of pendingToolUseIds) {
        maps.finishedToolUseIds.add(toolUseId);
      }
      await callbacks.onToolFinished({
        summary: msg.summary,
        precedingToolUseIds: pendingToolUseIds,
        ...(() => {
          for (const toolUseId of pendingToolUseIds) {
            const resp = maps.subagentResponseByUseId.get(toolUseId);
            if (resp) return { subagentResponse: resp };
          }
          return {};
        })(),
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
          : {}),
      });

      if (subagentTaskToolUseId && summaryText) {
        await callbacks.onSubagentStopped({
          agentId: "",
          agentType: "",
          toolUseId: subagentTaskToolUseId,
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
        await emitInstrumentation({
          stage: "finished",
          toolUseId,
          toolName: metadata?.toolName ?? "unknown",
          parentToolUseId: null,
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

    if (
      (message as { type: string }).type === "system" &&
      "subtype" in message &&
      (message as { subtype?: string }).subtype === "files_persisted"
    ) {
      const filesPersistedMessage = message as { files?: Array<{ filename: string; file_id: string }> };
      const files = filesPersistedMessage.files ?? [];
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

    if ((message as { type: string }).type === "assistant") {
      const textParts: string[] = [];
      const assistantMsg = message as { message: { content: Array<{ type: string; text?: string }> } };

      for (const part of assistantMsg.message.content) {
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
  if (detectedPlan) {
    await callbacks.onPlanFileDetected(detectedPlan);
  } else if (state.finalOutput.trim().length > 0) {
    await callbacks.onPlanFileDetected({
      filePath: "streaming-plan",
      content: state.finalOutput.trim(),
      source: "streaming_fallback",
    });
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
    const bashResult = maps.bashResultByToolUseId.get(toolUseId);
    const finishedAtMs = Date.now();
    const completionSummary = completionSummaryFromMetadata(metadata);
    await callbacks.onToolFinished(buildToolFinishedPayload(metadata, completionSummary, [toolUseId], bashResult));
    const { timing, preview } = buildFinishedTimingPreview(toolUseId, metadata, finishedAtMs, maps, bashResult);
    await emitInstrumentation({
      stage: "finished",
      toolUseId,
      toolName: metadata.toolName,
      parentToolUseId: maps.requestedToolByUseId.get(toolUseId)?.parentToolUseId ?? null,
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
