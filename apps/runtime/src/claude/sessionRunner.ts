import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeRunner } from "../types";

const MAX_CAPTURED_STDERR_LINES = 12;
const MAX_BASH_OUTPUT_BYTES = 20 * 1024;
const DEFAULT_CLAUDE_EXECUTABLE = "claude";
const COMMON_CLAUDE_EXECUTABLE_PATHS = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
let cachedClaudeExecutable: string | null = null;

type ToolMetadata = {
  toolName: string;
  command?: string;
  isBash: boolean;
};

type BashToolResult = {
  output?: string;
  error?: string;
  truncated: boolean;
  outputBytes: number;
};

function resolveExecutablePath(commandOrPath: string): string {
  function findCommonInstalledPath(): string | null {
    for (const candidate of COMMON_CLAUDE_EXECUTABLE_PATHS) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function resolveByWhich(command: string): string {
    try {
      const resolved = execFileSync("which", [command], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      if (resolved.length > 0) {
        return resolved;
      }
    } catch {
      // Fall through and let SDK report a clear executable-not-found error.
    }

    return command;
  }

  if (commandOrPath.includes("/")) {
    if (existsSync(commandOrPath)) {
      return commandOrPath;
    }

    if (commandOrPath !== DEFAULT_CLAUDE_EXECUTABLE) {
      const fallback = resolveByWhich(DEFAULT_CLAUDE_EXECUTABLE);
      if (fallback !== DEFAULT_CLAUDE_EXECUTABLE) {
        return fallback;
      }

      const commonInstalledPath = findCommonInstalledPath();
      if (commonInstalledPath) {
        return commonInstalledPath;
      }
    }

    return commandOrPath;
  }

  const resolved = resolveByWhich(commandOrPath);
  if (resolved !== commandOrPath) {
    return resolved;
  }

  const commonInstalledPath = findCommonInstalledPath();
  if (commonInstalledPath) {
    return commonInstalledPath;
  }

  return commandOrPath;
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

function buildExecutableCandidates(configuredExecutable: string): string[] {
  const resolvedConfigured = resolveExecutablePath(configuredExecutable);
  const resolvedDefault = resolveExecutablePath(DEFAULT_CLAUDE_EXECUTABLE);
  return dedupePreserveOrder([
    cachedClaudeExecutable ?? "",
    configuredExecutable,
    resolvedConfigured,
    DEFAULT_CLAUDE_EXECUTABLE,
    resolvedDefault,
    ...COMMON_CLAUDE_EXECUTABLE_PATHS,
  ]);
}

function isSpawnEnoent(error: unknown): boolean {
  return error instanceof Error && /spawn .* ENOENT/i.test(error.message);
}

function selectExecutableForCurrentProcess(candidates: string[], env: NodeJS.ProcessEnv): string {
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env,
      });
      cachedClaudeExecutable = candidate;
      return candidate;
    } catch (error) {
      if (!isSpawnEnoent(error)) {
        continue;
      }
    }
  }

  return candidates[0] ?? DEFAULT_CLAUDE_EXECUTABLE;
}

function captureStderrLine(buffer: string[], data: string) {
  const normalized = data.trim();
  if (normalized.length === 0) {
    return;
  }

  buffer.push(normalized);

  if (buffer.length > MAX_CAPTURED_STDERR_LINES) {
    buffer.splice(0, buffer.length - MAX_CAPTURED_STDERR_LINES);
  }
}

function withClaudeSetupHint(error: unknown, recentStderr: string[], claudeExecutable: string) {
  if (!(error instanceof Error)) {
    return error;
  }

  if (/spawn .* ENOENT/i.test(error.message)) {
    const hintLines = [
      `Claude Code executable was not found: ${claudeExecutable}`,
      "Set CLAUDE_CODE_EXECUTABLE in apps/runtime/.env to a valid path or use `claude`.",
      "Verify binary availability for the runtime user with `which claude` and `claude --version`.",
    ];

    return new Error(hintLines.join("\n"), { cause: error });
  }

  if (!/Claude Code process exited with code 1/i.test(error.message)) {
    return error;
  }

  const hintLines = [
    `Claude Code failed to start. Runtime is using Claude CLI (${claudeExecutable}).`,
    "Ensure the executable exists for the runtime user and run `claude login` for the same user account.",
    "Set CLAUDE_CODE_EXECUTABLE in apps/runtime/.env if your binary path is different.",
  ];

  if (recentStderr.length > 0) {
    hintLines.push("", "Recent Claude stderr:", ...recentStderr);
  }

  return new Error(hintLines.join("\n"), { cause: error });
}

function isBashTool(toolName: string): boolean {
  return toolName.trim().toLowerCase() === "bash";
}

function commandFromToolInput(input: Record<string, unknown>): string | undefined {
  const command = input.command;
  if (typeof command !== "string") {
    return undefined;
  }

  const normalized = command.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function commandFromUnknownToolInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input == null || Array.isArray(input)) {
    return undefined;
  }

  return commandFromToolInput(input as Record<string, unknown>);
}

function truncateUtf8(input: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes <= maxBytes) {
    return input;
  }

  return Buffer.from(input, "utf8").subarray(0, maxBytes).toString("utf8");
}

function truncateBashResult(output: string, error: string): BashToolResult {
  const outputBytes = Buffer.byteLength(output, "utf8") + Buffer.byteLength(error, "utf8");

  if (outputBytes <= MAX_BASH_OUTPUT_BYTES) {
    return {
      output: output.length > 0 ? output : undefined,
      error: error.length > 0 ? error : undefined,
      truncated: false,
      outputBytes,
    };
  }

  let remainingBytes = MAX_BASH_OUTPUT_BYTES;
  const truncatedOutput = truncateUtf8(output, remainingBytes);
  remainingBytes -= Buffer.byteLength(truncatedOutput, "utf8");
  const truncatedError = truncateUtf8(error, remainingBytes);

  return {
    output: truncatedOutput.length > 0 ? truncatedOutput : undefined,
    error: truncatedError.length > 0 ? truncatedError : undefined,
    truncated: true,
    outputBytes,
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstNonEmptyString(values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const normalized = value.trim();
    if (normalized.length > 0) {
      return value;
    }
  }

  return "";
}

function contentToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  const chunks: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      chunks.push(entry);
      continue;
    }

    if (typeof entry !== "object" || entry == null || Array.isArray(entry)) {
      continue;
    }

    const text = (entry as Record<string, unknown>).text;
    if (typeof text === "string" && text.length > 0) {
      chunks.push(text);
    }
  }

  return chunks.join("\n").trim();
}

function extractBashToolResult(toolResponse: unknown): BashToolResult | null {
  if (typeof toolResponse === "string") {
    const normalized = toolResponse.trim();
    if (normalized.length === 0) {
      return null;
    }

    const likelyError = normalized.toLowerCase().startsWith("error:");
    return likelyError
      ? truncateBashResult("", normalized)
      : truncateBashResult(toolResponse, "");
  }

  if (typeof toolResponse !== "object" || toolResponse == null || Array.isArray(toolResponse)) {
    return null;
  }

  const response = toolResponse as Record<string, unknown>;
  const nested = typeof response.result === "object" && response.result != null && !Array.isArray(response.result)
    ? (response.result as Record<string, unknown>)
    : null;
  const output = firstNonEmptyString([
    response.output,
    response.stdout,
    nested?.output,
    nested?.stdout,
  ]);
  const error = firstNonEmptyString([
    response.error,
    response.stderr,
    nested?.error,
    nested?.stderr,
  ]);
  if (output.length > 0 || error.length > 0) {
    return truncateBashResult(output, error);
  }

  const content = contentToString(response.content);
  if (content.length > 0) {
    if (response.is_error === true) {
      return truncateBashResult("", content);
    }

    return truncateBashResult(content, "");
  }

  const toolUseResultText = asString(response.toolUseResult);
  if (toolUseResultText.trim().length > 0) {
    const likelyError = toolUseResultText.trim().toLowerCase().startsWith("error:");
    return likelyError
      ? truncateBashResult("", toolUseResultText)
      : truncateBashResult(toolUseResultText, "");
  }

  const rawError = asString(response.message);
  if (rawError.trim().length > 0 && response.is_error === true) {
    return truncateBashResult("", rawError);
  }

  return null;
}

export const __testing = {
  extractBashToolResult,
};

function findLatestPlanFile(afterTimestamp: number): { filePath: string; content: string } | null {
  const plansDir = join(homedir(), ".claude", "plans");
  if (!existsSync(plansDir)) {
    return null;
  }

  let latestFile: { filePath: string; mtime: number } | null = null;
  try {
    const entries = readdirSync(plansDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      const filePath = join(plansDir, entry);
      const stat = statSync(filePath);
      if (stat.mtimeMs > afterTimestamp && (!latestFile || stat.mtimeMs > latestFile.mtime)) {
        latestFile = { filePath, mtime: stat.mtimeMs };
      }
    }
  } catch {
    return null;
  }

  if (!latestFile) {
    return null;
  }

  try {
    const content = readFileSync(latestFile.filePath, "utf-8");
    return content.trim().length > 0 ? { filePath: latestFile.filePath, content } : null;
  } catch {
    return null;
  }
}

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
}) => {
  let latestSessionId: string | null = sessionId;
  let finalOutput = "";
  const recentStderr: string[] = [];
  const queryStartTimestamp = Date.now();
  let planFileDetected = false;
  const startedToolUseIds = new Set<string>();
  const finishedToolUseIds = new Set<string>();
  const toolMetadataByUseId = new Map<string, ToolMetadata>();
  const bashResultByToolUseId = new Map<string, BashToolResult>();

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
            return {
              behavior: "deny",
              message: "Plan requires user approval before execution.",
            };
          }

          if (toolName === "AskUserQuestion") {
            const questions = Array.isArray(input.questions) ? input.questions : [];
            const result = await onQuestionRequest({
              requestId: options.toolUseID,
              questions,
            });
            return {
              behavior: "allow",
              updatedInput: { ...input, answers: result.answers },
            };
          }

          const command = commandFromToolInput(input);
          const isBash = isBashTool(toolName);
          if (isBash) {
            toolMetadataByUseId.set(options.toolUseID, {
              toolName,
              command,
              isBash,
            });
          }

          const requiresUserApproval = Boolean(
            options.blockedPath || options.decisionReason || (options.suggestions?.length ?? 0) > 0,
          );

          if (!requiresUserApproval) {
            return {
              behavior: "allow",
              updatedInput: input,
            };
          }

          if (autoAcceptTools) {
            return {
              behavior: "allow",
              updatedInput: input,
            };
          }

          const decision = await onPermissionRequest({
            requestId: options.toolUseID,
            toolName,
            toolInput: input,
            blockedPath: options.blockedPath ?? null,
            decisionReason: options.decisionReason ?? null,
            suggestions: options.suggestions ?? null,
          });

          if (decision.decision === "allow") {
            return {
              behavior: "allow",
              updatedInput: input,
            };
          }

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
                  if (!hookToolUseId || !isBashTool(hookInput.tool_name)) {
                    return { continue: true };
                  }

                  const command = commandFromUnknownToolInput(hookInput.tool_input);
                  toolMetadataByUseId.set(hookToolUseId, {
                    toolName: hookInput.tool_name,
                    command,
                    isBash: true,
                  });

                  if (!startedToolUseIds.has(hookToolUseId)) {
                    startedToolUseIds.add(hookToolUseId);
                    await onToolStarted({
                      toolName: hookInput.tool_name,
                      toolUseId: hookToolUseId,
                      parentToolUseId: null,
                      command,
                      shell: "bash",
                      isBash: true,
                    });
                  }

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

                  const metadata = toolMetadataByUseId.get(hookToolUseId);
                  const bashResult = extractBashToolResult(hookInput.tool_response);
                  if (!metadata?.isBash) {
                    return { continue: true };
                  }

                  if (bashResult) {
                    bashResultByToolUseId.set(hookToolUseId, bashResult);
                  }

                  if (!finishedToolUseIds.has(hookToolUseId)) {
                    await onToolFinished({
                      summary: metadata.command ? `Ran ${metadata.command}` : "Ran bash command",
                      precedingToolUseIds: [hookToolUseId],
                      command: metadata.command,
                      shell: "bash",
                      isBash: true,
                      output: bashResult?.output,
                      error: bashResult?.error,
                      truncated: bashResult?.truncated ?? false,
                      outputBytes: bashResult?.outputBytes ?? 0,
                    });
                    finishedToolUseIds.add(hookToolUseId);
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
                  if (!hookToolUseId || !isBashTool(hookInput.tool_name)) {
                    return { continue: true };
                  }

                  const metadata = toolMetadataByUseId.get(hookToolUseId);
                  const command = metadata?.command ?? commandFromUnknownToolInput(hookInput.tool_input);
                  if (finishedToolUseIds.has(hookToolUseId)) {
                    return { continue: true };
                  }

                  await onToolFinished({
                    summary: command ? `Failed ${command}` : "Bash command failed",
                    precedingToolUseIds: [hookToolUseId],
                    command,
                    shell: "bash",
                    isBash: true,
                    error: hookInput.error,
                    truncated: false,
                    outputBytes: Buffer.byteLength(hookInput.error, "utf8"),
                  });
                  finishedToolUseIds.add(hookToolUseId);
                  return { continue: true };
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
          finalOutput += event.delta.text;
          await onText(event.delta.text);
        }
        continue;
      }

      if (message.type === "tool_progress") {
        const metadata = toolMetadataByUseId.get(message.tool_use_id);

        if (!startedToolUseIds.has(message.tool_use_id)) {
          startedToolUseIds.add(message.tool_use_id);
          await onToolStarted({
            toolName: message.tool_name,
            toolUseId: message.tool_use_id,
            parentToolUseId: message.parent_tool_use_id,
            ...(metadata?.isBash
              ? {
                  command: metadata.command,
                  shell: "bash" as const,
                  isBash: true as const,
                }
              : {}),
          });
        }

        await onToolOutput({
          toolName: message.tool_name,
          toolUseId: message.tool_use_id,
          parentToolUseId: message.parent_tool_use_id,
          elapsedTimeSeconds: message.elapsed_time_seconds,
        });
        continue;
      }

      if (message.type === "tool_use_summary") {
        const pendingToolUseIds = message.preceding_tool_use_ids.filter((toolUseId) => !finishedToolUseIds.has(toolUseId));
        if (pendingToolUseIds.length === 0) {
          for (const toolUseId of message.preceding_tool_use_ids) {
            toolMetadataByUseId.delete(toolUseId);
            bashResultByToolUseId.delete(toolUseId);
          }
          continue;
        }

        const bashToolUseId = pendingToolUseIds.find((toolUseId) => toolMetadataByUseId.get(toolUseId)?.isBash);
        const bashToolMetadata = bashToolUseId ? toolMetadataByUseId.get(bashToolUseId) : undefined;
        const bashToolResult = bashToolUseId ? bashResultByToolUseId.get(bashToolUseId) : undefined;
        for (const toolUseId of pendingToolUseIds) {
          finishedToolUseIds.add(toolUseId);
        }
        await onToolFinished({
          summary: message.summary,
          precedingToolUseIds: pendingToolUseIds,
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

        for (const toolUseId of message.preceding_tool_use_ids) {
          toolMetadataByUseId.delete(toolUseId);
          bashResultByToolUseId.delete(toolUseId);
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

    for (const [toolUseId, metadata] of toolMetadataByUseId.entries()) {
      if (!metadata.isBash || !startedToolUseIds.has(toolUseId) || finishedToolUseIds.has(toolUseId)) {
        continue;
      }

      const bashToolResult = bashResultByToolUseId.get(toolUseId);
      await onToolFinished({
        summary: metadata.command ? `Ran ${metadata.command}` : "Ran bash command",
        precedingToolUseIds: [toolUseId],
        command: metadata.command,
        shell: "bash",
        isBash: true,
        output: bashToolResult?.output,
        error: bashToolResult?.error,
        truncated: bashToolResult?.truncated ?? false,
        outputBytes: bashToolResult?.outputBytes ?? 0,
      });
      finishedToolUseIds.add(toolUseId);
    }
  } catch (error) {
    throw withClaudeSetupHint(error, recentStderr, claudeExecutable);
  }

  return {
    output: finalOutput.trim(),
    sessionId: latestSessionId,
  };
};
