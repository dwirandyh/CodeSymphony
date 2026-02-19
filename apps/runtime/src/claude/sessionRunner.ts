import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import type { ClaudeRunner, ClaudeToolInstrumentationDecision, ClaudeToolInstrumentationEvent } from "../types";

import { sanitizeForLog, truncateForPreview, toIso } from "./sanitize";
import {
  isBashTool,
  isSearchTool,
  isEditTool,
  commandFromToolInput,
  commandFromUnknownToolInput,
  readTargetFromUnknownToolInput,
  searchParamsFromUnknownToolInput,
  editTargetFromUnknownToolInput,
  type ToolMetadata,
} from "./toolClassification";
import { completionSummaryFromMetadata, failureSummaryFromMetadata } from "./toolSummary";
import { extractBashToolResult, type BashToolResult } from "./bashResult";
import {
  DEFAULT_CLAUDE_EXECUTABLE,
  buildExecutableCandidates,
  selectExecutableForCurrentProcess,
  captureStderrLine,
  withClaudeSetupHint,
} from "./executableResolver";
import { parseSubagentTranscript, extractSubagentResponse } from "./subagentTranscript";
import { findLatestPlanFile } from "./planFile";

// Re-export for backward-compatible __testing API used by existing tests
export const __testing = {
  extractBashToolResult,
  sanitizeForLog,
};

export const runClaudeWithStreaming: ClaudeRunner = async ({
  prompt,
  sessionId,
  cwd,
  abortController,
  permissionMode,
  autoAcceptTools,
  onText,
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
  let latestSessionId: string | null = sessionId;
  let finalOutput = "";
  let sawToolUseSinceLastText = false;
  const recentStderr: string[] = [];
  const queryStartTimestamp = Date.now();
  let planFileDetected = false;
  const startedToolUseIds = new Set<string>();
  const finishedToolUseIds = new Set<string>();
  const toolMetadataByUseId = new Map<string, ToolMetadata>();
  const bashResultByToolUseId = new Map<string, BashToolResult>();
  const requestedToolByUseId = new Map<string, { toolName: string; parentToolUseId: string | null; requestedAtMs: number }>();
  const agentIdToToolUseId = new Map<string, string>();
  const decisionByToolUseId = new Map<string, ClaudeToolInstrumentationDecision>();
  const startedAtMsByToolUseId = new Map<string, number>();
  const progressByToolUseId = new Map<string, { count: number; maxElapsedTimeSeconds: number }>();
  const summaryUnknownToolUseIds = new Set<string>();

  const subagentToolInputByUseId = new Map<string, Record<string, unknown>>();
  const subagentResponseByUseId = new Map<string, string>();
  const instrumentContext = {
    cwd,
    sessionId,
    permissionMode: permissionMode ?? "default",
    autoAcceptTools: Boolean(autoAcceptTools),
  };

  async function emitInstrumentation(event: ClaudeToolInstrumentationEvent): Promise<void> {
    if (!onToolInstrumentation) {
      return;
    }

    try {
      await onToolInstrumentation(event);
    } catch {
      // Instrumentation must never break the Claude stream.
    }
  }

  async function emitDecision(
    toolUseId: string,
    decision: ClaudeToolInstrumentationDecision,
    toolName: string,
    parentToolUseId: string | null,
    preview: ClaudeToolInstrumentationEvent["preview"],
  ): Promise<void> {
    decisionByToolUseId.set(toolUseId, decision);
    await emitInstrumentation({
      stage: "decision",
      toolUseId,
      toolName,
      parentToolUseId,
      decision,
      threadContext: instrumentContext,
      preview,
    });
  }

  async function markStarted(
    toolUseId: string,
    toolName: string,
    parentToolUseId: string | null,
    startSource: "sdk.hook.pre_tool_use" | "sdk.stream.tool_progress",
    metadata?: ToolMetadata,
  ): Promise<void> {
    if (startedToolUseIds.has(toolUseId)) {
      return;
    }

    startedToolUseIds.add(toolUseId);
    const startedAtMs = Date.now();
    startedAtMsByToolUseId.set(toolUseId, startedAtMs);
    await onToolStarted({
      toolName,
      toolUseId,
      parentToolUseId,
      ...(metadata?.editTarget
        ? {
          editTarget: metadata.editTarget,
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
  }

  function buildMetadataFromHookInput(hookInput: Record<string, unknown>, hookToolUseId: string): ToolMetadata {
    const existing = toolMetadataByUseId.get(hookToolUseId);
    const metadata: ToolMetadata = existing ?? {
      toolName: hookInput.tool_name as string,
      command: commandFromUnknownToolInput(hookInput.tool_input),
      readTarget: readTargetFromUnknownToolInput(hookInput.tool_name as string, hookInput.tool_input),
      searchParams: searchParamsFromUnknownToolInput(hookInput.tool_name as string, hookInput.tool_input),
      editTarget: editTargetFromUnknownToolInput(hookInput.tool_name as string, hookInput.tool_input),
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
    toolMetadataByUseId.set(hookToolUseId, metadata);
    return metadata;
  }

  function buildFinishedTimingPreview(
    toolUseId: string,
    metadata: ToolMetadata,
    finishedAtMs: number,
    bashResult?: BashToolResult,
    hookToolResponse?: unknown,
  ) {
    const progress = progressByToolUseId.get(toolUseId);
    const startedAtMs = startedAtMsByToolUseId.get(toolUseId);
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

  function buildToolFinishedPayload(
    metadata: ToolMetadata,
    summary: string,
    toolUseIds: string[],
    bashResult?: BashToolResult,
    subagentResponse?: string,
  ) {
    return {
      summary,
      precedingToolUseIds: toolUseIds,
      ...(subagentResponse ? { subagentResponse } : {}),
      ...(metadata.editTarget
        ? { editTarget: metadata.editTarget }
        : {}),
      ...(metadata.isBash
        ? {
          command: metadata.command,
          shell: "bash" as const,
          isBash: true as const,
          output: bashResult?.output,
          error: bashResult?.error,
          truncated: bashResult?.truncated ?? false,
          outputBytes: bashResult?.outputBytes ?? 0,
        }
        : metadata.searchParams
          ? { searchParams: metadata.searchParams }
          : {}),
    };
  }

  const configuredExecutable = process.env.CLAUDE_CODE_EXECUTABLE?.trim() || DEFAULT_CLAUDE_EXECUTABLE;

  const runtimeEnv = {
    ...process.env,
  } as NodeJS.ProcessEnv;

  delete runtimeEnv.CLAUDECODE;
  delete runtimeEnv.ANTHROPIC_API_KEY;
  delete runtimeEnv.ANTHROPIC_BASE_URL;
  const candidateExecutables = buildExecutableCandidates(configuredExecutable);
  const claudeExecutable = selectExecutableForCurrentProcess(candidateExecutables, runtimeEnv);

  try {
    const stream = query({
      prompt,
      options: {
        abortController,
        includePartialMessages: true,
        resume: sessionId ?? undefined,
        permissionMode: permissionMode ?? "default",
        canUseTool: async (toolName, input, options) => {
          const toolUseId = options.toolUseID;
          const command = commandFromToolInput(input);
          const isBash = isBashTool(toolName);
          const nowMs = Date.now();

          toolMetadataByUseId.set(toolUseId, {
            toolName,
            command,
            readTarget: readTargetFromUnknownToolInput(toolName, input),
            searchParams: searchParamsFromUnknownToolInput(toolName, input),
            editTarget: editTargetFromUnknownToolInput(toolName, input),
            isBash,
          });
          subagentToolInputByUseId.set(toolUseId, input);
          requestedToolByUseId.set(toolUseId, {
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
              startedAt: toIso(nowMs),
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
            if (!planFileDetected && finalOutput.trim().length > 0) {
              planFileDetected = true;
              const planFile = findLatestPlanFile(queryStartTimestamp);
              await onPlanFileDetected({
                filePath: planFile?.filePath ?? "streaming-plan",
                content: planFile?.content ?? finalOutput.trim(),
                source: planFile ? "claude_plan_file" : "streaming_fallback",
              });
            }
            await emitDecision(toolUseId, "plan_deny", toolName, null, {
              ...(command ? { command } : {}),
              input: sanitizeForLog(input),
              decisionReason: "Plan requires user approval before execution.",
            });
            return {
              behavior: "deny",
              message: "Plan requires user approval before execution.",
            };
          }

          if (toolName === "AskUserQuestion") {
            if (permissionMode !== "plan") {
              await emitDecision(toolUseId, "deny", toolName, null, {
                input: sanitizeForLog(input),
                decisionReason: "Questions are not allowed in execute mode.",
              });
              return {
                behavior: "deny",
                message: "Questions are not allowed in execute mode. Proceed with your best judgment.",
              };
            }
            const questions = Array.isArray(input.questions) ? input.questions : [];
            const result = await onQuestionRequest({
              requestId: toolUseId,
              questions,
            });
            await emitDecision(toolUseId, "allow", toolName, null, {
              input: sanitizeForLog(input),
            });
            return {
              behavior: "allow",
              updatedInput: { ...input, answers: result.answers },
            };
          }

          const requiresUserApproval = Boolean(
            options.blockedPath || options.decisionReason || (options.suggestions?.length ?? 0) > 0,
          );

          if (!requiresUserApproval) {
            await emitDecision(toolUseId, "allow", toolName, null, {
              ...(command ? { command } : {}),
              input: sanitizeForLog(input),
            });
            return {
              behavior: "allow",
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
              behavior: "allow",
              updatedInput: input,
            };
          }

          const decision = await onPermissionRequest({
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
              behavior: "allow",
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
            behavior: "deny",
            message: decision.message ?? "Tool execution denied by user.",
          };
        },
        tools: {
          type: "preset",
          preset: "claude_code",
        },
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (hookInput, toolUseID) => {
                  if (hookInput.hook_event_name !== "PreToolUse") {
                    return { continue: true };
                  }

                  const hookToolUseId = hookInput.tool_use_id || toolUseID;
                  if (!hookToolUseId) {
                    return { continue: true };
                  }

                  const command = commandFromUnknownToolInput(hookInput.tool_input);
                  toolMetadataByUseId.set(hookToolUseId, {
                    toolName: hookInput.tool_name,
                    command,
                    readTarget: readTargetFromUnknownToolInput(hookInput.tool_name, hookInput.tool_input),
                    searchParams: searchParamsFromUnknownToolInput(hookInput.tool_name, hookInput.tool_input),
                    isBash: isBashTool(hookInput.tool_name),
                  });
                  requestedToolByUseId.set(hookToolUseId, {
                    toolName: hookInput.tool_name,
                    parentToolUseId: null,
                    requestedAtMs: Date.now(),
                  });

                  await markStarted(
                    hookToolUseId,
                    hookInput.tool_name,
                    null,
                    "sdk.hook.pre_tool_use",
                    toolMetadataByUseId.get(hookToolUseId),
                  );

                  return { continue: true };
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                async (hookInput, toolUseID) => {
                  if (hookInput.hook_event_name !== "PostToolUse") {
                    return { continue: true };
                  }

                  const hookToolUseId = hookInput.tool_use_id || toolUseID;
                  if (!hookToolUseId) {
                    return { continue: true };
                  }

                  const metadata = buildMetadataFromHookInput(hookInput, hookToolUseId);
                  const bashResult = extractBashToolResult(hookInput.tool_response);
                  if (metadata.isBash && bashResult) {
                    bashResultByToolUseId.set(hookToolUseId, bashResult);
                  }

                  // Capture subagent's final response from tool_response
                  if (hookInput.tool_name.toLowerCase() === "task") {
                    const responseText = extractSubagentResponse(hookInput.tool_response);
                    if (responseText) {
                      subagentResponseByUseId.set(hookToolUseId, responseText);
                    }
                  }

                  if (!finishedToolUseIds.has(hookToolUseId)) {
                    const finishedAtMs = Date.now();
                    const completionSummary = completionSummaryFromMetadata(metadata, hookInput.tool_input);
                    await onToolFinished(buildToolFinishedPayload(
                      metadata,
                      completionSummary,
                      [hookToolUseId],
                      bashResult ?? undefined,
                      subagentResponseByUseId.get(hookToolUseId),
                    ));
                    const { timing, preview } = buildFinishedTimingPreview(
                      hookToolUseId, metadata, finishedAtMs, bashResult ?? undefined, hookInput.tool_response,
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
                    finishedToolUseIds.add(hookToolUseId);
                  }

                  // Emit subagent response update AFTER the tool is finished
                  const capturedResponse = subagentResponseByUseId.get(hookToolUseId);
                  if (capturedResponse) {
                    await onSubagentStopped({
                      agentId: "",
                      agentType: "",
                      toolUseId: hookToolUseId,
                      description: "",
                      lastMessage: capturedResponse,
                      isResponseUpdate: true,
                    });
                    subagentResponseByUseId.delete(hookToolUseId);
                  }

                  return { continue: true };
                },
              ],
            },
          ],
          PostToolUseFailure: [
            {
              hooks: [
                async (hookInput, toolUseID) => {
                  if (hookInput.hook_event_name !== "PostToolUseFailure") {
                    return { continue: true };
                  }

                  const hookToolUseId = hookInput.tool_use_id || toolUseID;
                  if (!hookToolUseId) {
                    return { continue: true };
                  }

                  const metadata = buildMetadataFromHookInput(hookInput, hookToolUseId);
                  const command = metadata?.command ?? commandFromUnknownToolInput(hookInput.tool_input);
                  if (finishedToolUseIds.has(hookToolUseId)) {
                    return { continue: true };
                  }

                  const finishedAtMs = Date.now();
                  const failureSummary = failureSummaryFromMetadata(metadata, hookInput.tool_input, command);
                  await onToolFinished({
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
                    error: hookInput.error,
                    truncated: false,
                    outputBytes: Buffer.byteLength(hookInput.error, "utf8"),
                  });
                  const { timing } = buildFinishedTimingPreview(hookToolUseId, metadata, finishedAtMs);
                  await emitInstrumentation({
                    stage: "failed",
                    toolUseId: hookToolUseId,
                    toolName: metadata?.toolName ?? hookInput.tool_name,
                    parentToolUseId: null,
                    summary: failureSummary,
                    threadContext: instrumentContext,
                    timing,
                    preview: {
                      ...(command ? { command } : {}),
                      error: sanitizeForLog(hookInput.error) as string,
                      truncated: false,
                      outputBytes: Buffer.byteLength(hookInput.error, "utf8"),
                    },
                  });
                  finishedToolUseIds.add(hookToolUseId);
                  return { continue: true };
                },
              ],
            },
          ],
          SubagentStart: [
            {
              hooks: [
                async (hookInput: Record<string, unknown>, toolUseID?: string) => {
                  if (hookInput.hook_event_name !== "SubagentStart") {
                    return { continue: true };
                  }

                  const agentId = String(hookInput.agent_id ?? "");
                  const agentType = String(hookInput.agent_type ?? "unknown");
                  const resolvedToolUseId = String(hookInput.tool_use_id || toolUseID || "");

                  if (agentId && resolvedToolUseId) {
                    agentIdToToolUseId.set(agentId, resolvedToolUseId);
                  }

                  const toolInput = subagentToolInputByUseId.get(resolvedToolUseId);
                  const description = toolInput
                    ? String((toolInput as Record<string, unknown>).description
                      ?? (toolInput as Record<string, unknown>).prompt
                      ?? (toolInput as Record<string, unknown>).task
                      ?? (toolInput as Record<string, unknown>).Task
                      ?? "")
                    : "";

                  await onSubagentStarted({
                    agentId,
                    agentType,
                    toolUseId: resolvedToolUseId,
                    description,
                  });

                  return {};
                },
              ],
            },
          ],
          SubagentStop: [
            {
              hooks: [
                async (hookInput: Record<string, unknown>, toolUseID?: string) => {
                  if (hookInput.hook_event_name !== "SubagentStop") {
                    return { continue: true };
                  }

                  const agentId = String(hookInput.agent_id ?? "");
                  const agentType = String(hookInput.agent_type ?? "unknown");
                  const resolvedToolUseId = agentIdToToolUseId.get(agentId)
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

                  subagentToolInputByUseId.delete(resolvedToolUseId);

                  await onSubagentStopped({
                    agentId,
                    agentType,
                    toolUseId: resolvedToolUseId,
                    description,
                    lastMessage,
                  });

                  agentIdToToolUseId.delete(agentId);

                  return {};
                },
              ],
            },
          ],
        },
        pathToClaudeCodeExecutable: claudeExecutable,
        settingSources: ["local", "project", "user"],
        cwd,
        env: runtimeEnv,
        stderr: (data: string) => {
          captureStderrLine(recentStderr, data);
        },
      },
    });

    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        latestSessionId = message.session_id;
        continue;
      }

      if (message.type === "stream_event") {
        const event = message.event;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          if (message.parent_tool_use_id) {
            continue;
          }
          if (sawToolUseSinceLastText && finalOutput.length > 0 && !/\s$/.test(finalOutput)) {
            finalOutput += "\n\n";
            await onText("\n\n");
          }
          sawToolUseSinceLastText = false;
          finalOutput += event.delta.text;
          await onText(event.delta.text);
        }
        continue;
      }

      if (message.type === "tool_progress") {
        sawToolUseSinceLastText = true;
        const metadata = toolMetadataByUseId.get(message.tool_use_id);
        requestedToolByUseId.set(message.tool_use_id, {
          toolName: message.tool_name,
          parentToolUseId: message.parent_tool_use_id,
          requestedAtMs: Date.now(),
        });
        if (!metadata) {
          toolMetadataByUseId.set(message.tool_use_id, {
            toolName: message.tool_name,
            isBash: isBashTool(message.tool_name),
          });
        }

        const currentProgress = progressByToolUseId.get(message.tool_use_id) ?? {
          count: 0,
          maxElapsedTimeSeconds: 0,
        };
        currentProgress.count += 1;
        currentProgress.maxElapsedTimeSeconds = Math.max(
          currentProgress.maxElapsedTimeSeconds,
          message.elapsed_time_seconds,
        );
        progressByToolUseId.set(message.tool_use_id, currentProgress);

        await markStarted(
          message.tool_use_id,
          message.tool_name,
          message.parent_tool_use_id,
          "sdk.stream.tool_progress",
          toolMetadataByUseId.get(message.tool_use_id),
        );

        await onToolOutput({
          toolName: message.tool_name,
          toolUseId: message.tool_use_id,
          parentToolUseId: message.parent_tool_use_id,
          elapsedTimeSeconds: message.elapsed_time_seconds,
        });
        continue;
      }

      if (message.type === "tool_use_summary") {
        sawToolUseSinceLastText = true;
        const unresolvedStartedToolUseIds = Array.from(startedToolUseIds).filter((toolUseId) => !finishedToolUseIds.has(toolUseId));
        const summaryToolUseIds = message.preceding_tool_use_ids.length > 0
          ? message.preceding_tool_use_ids
          : unresolvedStartedToolUseIds
            .sort((left, right) => {
              const leftTimestamp = startedAtMsByToolUseId.get(left)
                ?? requestedToolByUseId.get(left)?.requestedAtMs
                ?? 0;
              const rightTimestamp = startedAtMsByToolUseId.get(right)
                ?? requestedToolByUseId.get(right)?.requestedAtMs
                ?? 0;
              return rightTimestamp - leftTimestamp;
            })
            .slice(0, 1);

        const pendingToolUseIds = summaryToolUseIds.filter((toolUseId) => !finishedToolUseIds.has(toolUseId));
        for (const toolUseId of summaryToolUseIds) {
          if (!toolMetadataByUseId.has(toolUseId)) {
            summaryUnknownToolUseIds.add(toolUseId);
          }
        }
        if (pendingToolUseIds.length === 0) {
          for (const toolUseId of summaryToolUseIds) {
            toolMetadataByUseId.delete(toolUseId);
            bashResultByToolUseId.delete(toolUseId);
            progressByToolUseId.delete(toolUseId);
          }
          continue;
        }

        const bashToolUseId = pendingToolUseIds.find((toolUseId) => toolMetadataByUseId.get(toolUseId)?.isBash);
        const bashToolMetadata = bashToolUseId ? toolMetadataByUseId.get(bashToolUseId) : undefined;
        const bashToolResult = bashToolUseId ? bashResultByToolUseId.get(bashToolUseId) : undefined;
        const editToolUseId = pendingToolUseIds.find((toolUseId) => {
          const editTarget = toolMetadataByUseId.get(toolUseId)?.editTarget;
          return typeof editTarget === "string" && editTarget.length > 0;
        });
        const editTarget = editToolUseId ? toolMetadataByUseId.get(editToolUseId)?.editTarget : undefined;
        const summaryText = typeof message.summary === "string" ? message.summary.trim() : "";
        let subagentTaskToolUseId: string | null = null;
        if (summaryText) {
          for (const toolUseId of pendingToolUseIds) {
            const metadata = toolMetadataByUseId.get(toolUseId);
            if (metadata?.toolName?.toLowerCase() === "task") {
              subagentResponseByUseId.set(toolUseId, summaryText);
              subagentTaskToolUseId = toolUseId;
              break;
            }
          }
        }

        for (const toolUseId of pendingToolUseIds) {
          finishedToolUseIds.add(toolUseId);
        }
        await onToolFinished({
          summary: message.summary,
          precedingToolUseIds: pendingToolUseIds,
          ...(() => {
            for (const toolUseId of pendingToolUseIds) {
              const resp = subagentResponseByUseId.get(toolUseId);
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
          await onSubagentStopped({
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
          const metadata = toolMetadataByUseId.get(toolUseId);
          const { timing, preview } = buildFinishedTimingPreview(
            toolUseId,
            metadata ?? { toolName: "unknown", isBash: false },
            finishedAtMs,
            bashToolMetadata?.isBash ? bashToolResult : undefined,
          );
          await emitInstrumentation({
            stage: "finished",
            toolUseId,
            toolName: metadata?.toolName ?? "unknown",
            parentToolUseId: null,
            summary: message.summary,
            threadContext: instrumentContext,
            timing,
            preview,
          });
        }

        for (const toolUseId of summaryToolUseIds) {
          toolMetadataByUseId.delete(toolUseId);
          bashResultByToolUseId.delete(toolUseId);
          progressByToolUseId.delete(toolUseId);
        }
        continue;
      }

      if (message.type === "system" && "subtype" in message && message.subtype === "files_persisted") {
        const filesPersistedMessage = message as { files?: Array<{ filename: string; file_id: string }> };
        const files = filesPersistedMessage.files ?? [];
        for (const file of files) {
          if (file.filename.includes(".claude/plans/") && file.filename.endsWith(".md")) {
            try {
              const content = readFileSync(file.filename, "utf-8");
              if (content.trim().length > 0) {
                planFileDetected = true;
                await onPlanFileDetected({ filePath: file.filename, content, source: "claude_plan_file" });
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
            textParts.push(part.text);
          }
        }

        if (textParts.length > 0 && finalOutput.length === 0) {
          finalOutput = textParts.join("\n");
        }
      }
    }

    if (permissionMode === "plan" && !planFileDetected) {
      const planFile = findLatestPlanFile(queryStartTimestamp);
      if (planFile) {
        await onPlanFileDetected({
          ...planFile,
          source: "claude_plan_file",
        });
      } else if (finalOutput.trim().length > 0) {
        await onPlanFileDetected({
          filePath: "streaming-plan",
          content: finalOutput.trim(),
          source: "streaming_fallback",
        });
      }
    }

    // Synthetic finish for started-but-not-finished tools
    for (const toolUseId of startedToolUseIds) {
      if (finishedToolUseIds.has(toolUseId)) {
        continue;
      }

      const metadata = toolMetadataByUseId.get(toolUseId) ?? {
        toolName: requestedToolByUseId.get(toolUseId)?.toolName ?? "unknown",
        isBash: false,
      };
      const bashResult = bashResultByToolUseId.get(toolUseId);
      const finishedAtMs = Date.now();
      const completionSummary = completionSummaryFromMetadata(metadata);
      await onToolFinished(buildToolFinishedPayload(metadata, completionSummary, [toolUseId], bashResult));
      const { timing, preview } = buildFinishedTimingPreview(toolUseId, metadata, finishedAtMs, bashResult);
      await emitInstrumentation({
        stage: "finished",
        toolUseId,
        toolName: metadata.toolName,
        parentToolUseId: requestedToolByUseId.get(toolUseId)?.parentToolUseId ?? null,
        summary: completionSummary,
        threadContext: instrumentContext,
        timing,
        preview,
      });
      finishedToolUseIds.add(toolUseId);
    }

    // Anomaly detection: requested but never started
    for (const [toolUseId, requested] of requestedToolByUseId.entries()) {
      const decision = decisionByToolUseId.get(toolUseId);
      const shouldFlag = decision === "allow" || decision === "auto_allow";
      if (!shouldFlag || startedToolUseIds.has(toolUseId)) {
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

    // Anomaly detection: started but never finished
    for (const toolUseId of startedToolUseIds) {
      if (finishedToolUseIds.has(toolUseId)) {
        continue;
      }

      const metadata = toolMetadataByUseId.get(toolUseId);
      await emitInstrumentation({
        stage: "anomaly",
        toolUseId,
        toolName: metadata?.toolName ?? requestedToolByUseId.get(toolUseId)?.toolName ?? "unknown",
        parentToolUseId: requestedToolByUseId.get(toolUseId)?.parentToolUseId ?? null,
        threadContext: instrumentContext,
        anomaly: {
          code: "started_not_finished",
          message: "Tool started but no finish event was observed.",
        },
      });
    }

    // Anomaly detection: unknown tool use IDs in summaries
    for (const toolUseId of summaryUnknownToolUseIds) {
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
  } catch (error) {
    throw withClaudeSetupHint(error, recentStderr, claudeExecutable);
  }

  return {
    output: finalOutput.trim(),
    sessionId: latestSessionId,
  };
};
