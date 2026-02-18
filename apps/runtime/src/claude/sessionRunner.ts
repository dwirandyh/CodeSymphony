import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeRunner, ClaudeToolInstrumentationDecision, ClaudeToolInstrumentationEvent } from "../types";

const MAX_CAPTURED_STDERR_LINES = 12;
const MAX_BASH_OUTPUT_BYTES = 20 * 1024;
const MAX_LOG_PREVIEW_STRING_CHARS = 500;
const MAX_LOG_PREVIEW_DEPTH = 4;
const MAX_LOG_PREVIEW_ARRAY_ITEMS = 20;
const MAX_LOG_PREVIEW_OBJECT_KEYS = 30;
const SENSITIVE_KEY_PATTERN = /(token|secret|password|api[_-]?key|authorization|cookie)/i;
const DEFAULT_CLAUDE_EXECUTABLE = "claude";
const COMMON_CLAUDE_EXECUTABLE_PATHS = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
let cachedClaudeExecutable: string | null = null;

type ToolMetadata = {
  toolName: string;
  command?: string;
  readTarget?: string;
  searchParams?: string;
  isBash: boolean;
};

type BashToolResult = {
  output?: string;
  error?: string;
  truncated: boolean;
  outputBytes: number;
};

function truncateForPreview(input: string): string {
  if (input.length <= MAX_LOG_PREVIEW_STRING_CHARS) {
    return input;
  }

  return `${input.slice(0, MAX_LOG_PREVIEW_STRING_CHARS)}...`;
}

function sanitizeForLog(value: unknown, depth = 0, keyHint?: string): unknown {
  if (depth > MAX_LOG_PREVIEW_DEPTH) {
    return "[TruncatedDepth]";
  }

  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (keyHint && SENSITIVE_KEY_PATTERN.test(keyHint)) {
      return "[REDACTED]";
    }

    return truncateForPreview(value);
  }

  if (Array.isArray(value)) {
    const sliced = value.slice(0, MAX_LOG_PREVIEW_ARRAY_ITEMS);
    const mapped = sliced.map((entry) => sanitizeForLog(entry, depth + 1));
    if (value.length > MAX_LOG_PREVIEW_ARRAY_ITEMS) {
      mapped.push(`[+${value.length - MAX_LOG_PREVIEW_ARRAY_ITEMS} more]`);
    }
    return mapped;
  }

  if (typeof value !== "object") {
    return String(value);
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const keys = Object.keys(record).slice(0, MAX_LOG_PREVIEW_OBJECT_KEYS);
  for (const key of keys) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = sanitizeForLog(record[key], depth + 1, key);
  }
  if (Object.keys(record).length > MAX_LOG_PREVIEW_OBJECT_KEYS) {
    output.__truncatedKeys = Object.keys(record).length - MAX_LOG_PREVIEW_OBJECT_KEYS;
  }
  return output;
}

function toIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

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

function isSearchTool(toolName: string): boolean {
  return /^(glob|grep|search|find|list|scan|ls)$/i.test(toolName.trim());
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

function stringFromUnknown(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const normalized = input.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return truncateForPreview(normalized);
}

function readTargetFromUnknownToolInput(toolName: string, input: unknown): string | undefined {
  if (toolName.trim().toLowerCase() !== "read") {
    return undefined;
  }

  if (typeof input !== "object" || input == null || Array.isArray(input)) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const directKeyCandidates = ["path", "file_path", "filepath", "file", "target", "url"];
  for (const key of directKeyCandidates) {
    const candidate = stringFromUnknown(record[key]);
    if (candidate) {
      return candidate;
    }
  }

  const listKeyCandidates = ["paths", "files"];
  for (const key of listKeyCandidates) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      const candidate = stringFromUnknown(entry);
      if (candidate) {
        return candidate;
      }
    }
  }

  return undefined;
}

function formatSearchParamValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return stringFromUnknown(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const values: string[] = [];
  for (const entry of value) {
    const mapped = formatSearchParamValue(entry);
    if (!mapped) {
      continue;
    }
    values.push(mapped);
    if (values.length >= 3) {
      break;
    }
  }
  if (values.length === 0) {
    return undefined;
  }

  return values.join(" | ");
}

function searchParamsFromUnknownToolInput(toolName: string, input: unknown): string | undefined {
  if (!isSearchTool(toolName)) {
    return undefined;
  }

  if (typeof input !== "object" || input == null || Array.isArray(input)) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const preferredKeys = [
    "pattern",
    "query",
    "search",
    "regex",
    "glob",
    "grep",
    "path",
    "file",
    "file_path",
    "filename",
    "include",
    "exclude",
    "directory",
    "dir",
  ];
  const queue = [
    ...preferredKeys,
    ...Object.keys(record).filter((key) => !preferredKeys.includes(key)),
  ];

  const parts: string[] = [];
  for (const key of queue) {
    if (parts.length >= 4) {
      break;
    }
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }
    const raw = formatSearchParamValue(record[key]);
    if (!raw) {
      continue;
    }
    parts.push(`${key}=${raw}`);
  }

  if (parts.length === 0) {
    return undefined;
  }

  return truncateForPreview(parts.join(", "));
}

function completionSummaryFromMetadata(metadata: ToolMetadata, toolInput?: unknown): string {
  if (metadata.command) {
    return `Ran ${metadata.command}`;
  }

  if (metadata.isBash) {
    return "Ran bash command";
  }

  const readTarget = metadata.readTarget ?? readTargetFromUnknownToolInput(metadata.toolName, toolInput);
  if (readTarget) {
    return `Read ${readTarget}`;
  }

  return `Completed ${metadata.toolName}`;
}

function failureSummaryFromMetadata(metadata: ToolMetadata, toolInput: unknown, command?: string): string {
  if (command) {
    return `Failed ${command}`;
  }

  if (metadata.isBash) {
    return "Bash command failed";
  }

  const readTarget = metadata.readTarget ?? readTargetFromUnknownToolInput(metadata.toolName, toolInput);
  if (readTarget) {
    return `Failed to read ${readTarget}`;
  }

  return `${metadata.toolName} failed`;
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
  sanitizeForLog,
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
  onToolInstrumentation,
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
  const requestedToolByUseId = new Map<string, { toolName: string; parentToolUseId: string | null; requestedAtMs: number }>();
  const decisionByToolUseId = new Map<string, ClaudeToolInstrumentationDecision>();
  const startedAtMsByToolUseId = new Map<string, number>();
  const progressByToolUseId = new Map<string, { count: number; maxElapsedTimeSeconds: number }>();
  const summaryUnknownToolUseIds = new Set<string>();
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
            isBash,
          });
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

                  const metadata = toolMetadataByUseId.get(hookToolUseId) ?? {
                    toolName: hookInput.tool_name,
                    command: commandFromUnknownToolInput(hookInput.tool_input),
                    readTarget: readTargetFromUnknownToolInput(hookInput.tool_name, hookInput.tool_input),
                    searchParams: searchParamsFromUnknownToolInput(hookInput.tool_name, hookInput.tool_input),
                    isBash: isBashTool(hookInput.tool_name),
                  };
                  if (!metadata.readTarget) {
                    metadata.readTarget = readTargetFromUnknownToolInput(metadata.toolName, hookInput.tool_input);
                  }
                  if (!metadata.searchParams) {
                    metadata.searchParams = searchParamsFromUnknownToolInput(metadata.toolName, hookInput.tool_input);
                  }
                  toolMetadataByUseId.set(hookToolUseId, metadata);
                  const bashResult = extractBashToolResult(hookInput.tool_response);
                  if (metadata.isBash && bashResult) {
                    bashResultByToolUseId.set(hookToolUseId, bashResult);
                  }

                  if (!finishedToolUseIds.has(hookToolUseId)) {
                    const progress = progressByToolUseId.get(hookToolUseId);
                    const finishedAtMs = Date.now();
                    const startedAtMs = startedAtMsByToolUseId.get(hookToolUseId);
                    const completionSummary = completionSummaryFromMetadata(metadata, hookInput.tool_input);
                    await onToolFinished({
                      summary: completionSummary,
                      precedingToolUseIds: [hookToolUseId],
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
                          ? {
                              searchParams: metadata.searchParams,
                            }
                          : {}),
                    });
                    await emitInstrumentation({
                      stage: "finished",
                      toolUseId: hookToolUseId,
                      toolName: metadata.toolName,
                      parentToolUseId: null,
                      summary: completionSummary,
                      threadContext: instrumentContext,
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
                              output: typeof hookInput.tool_response === "string"
                                ? truncateForPreview(hookInput.tool_response)
                                : undefined,
                            }),
                      },
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
                  if (!hookToolUseId) {
                    return { continue: true };
                  }

                  const metadata = toolMetadataByUseId.get(hookToolUseId) ?? {
                    toolName: hookInput.tool_name,
                    command: commandFromUnknownToolInput(hookInput.tool_input),
                    readTarget: readTargetFromUnknownToolInput(hookInput.tool_name, hookInput.tool_input),
                    searchParams: searchParamsFromUnknownToolInput(hookInput.tool_name, hookInput.tool_input),
                    isBash: isBashTool(hookInput.tool_name),
                  };
                  if (!metadata.readTarget) {
                    metadata.readTarget = readTargetFromUnknownToolInput(metadata.toolName, hookInput.tool_input);
                  }
                  if (!metadata.searchParams) {
                    metadata.searchParams = searchParamsFromUnknownToolInput(metadata.toolName, hookInput.tool_input);
                  }
                  toolMetadataByUseId.set(hookToolUseId, metadata);
                  const command = metadata?.command ?? commandFromUnknownToolInput(hookInput.tool_input);
                  if (finishedToolUseIds.has(hookToolUseId)) {
                    return { continue: true };
                  }

                  const progress = progressByToolUseId.get(hookToolUseId);
                  const finishedAtMs = Date.now();
                  const startedAtMs = startedAtMsByToolUseId.get(hookToolUseId);
                  const failureSummary = failureSummaryFromMetadata(metadata, hookInput.tool_input, command);
                  await onToolFinished({
                    summary: failureSummary,
                    precedingToolUseIds: [hookToolUseId],
                    ...(metadata.isBash
                      ? {
                          command,
                          shell: "bash" as const,
                          isBash: true as const,
                        }
                      : metadata.searchParams
                        ? {
                            searchParams: metadata.searchParams,
                          }
                        : {}),
                    error: hookInput.error,
                    truncated: false,
                    outputBytes: Buffer.byteLength(hookInput.error, "utf8"),
                  });
                  await emitInstrumentation({
                    stage: "failed",
                    toolUseId: hookToolUseId,
                    toolName: metadata?.toolName ?? hookInput.tool_name,
                    parentToolUseId: null,
                    summary: failureSummary,
                    threadContext: instrumentContext,
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
        const finishedAtMs = Date.now();
        for (const toolUseId of pendingToolUseIds) {
          const metadata = toolMetadataByUseId.get(toolUseId);
          const progress = progressByToolUseId.get(toolUseId);
          const startedAtMs = startedAtMsByToolUseId.get(toolUseId);
          await emitInstrumentation({
            stage: "finished",
            toolUseId,
            toolName: metadata?.toolName ?? "unknown",
            parentToolUseId: null,
            summary: message.summary,
            threadContext: instrumentContext,
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
              ...(bashToolMetadata?.command ? { command: bashToolMetadata.command } : {}),
              ...(bashToolMetadata?.isBash
                ? {
                    output: sanitizeForLog(bashToolResult?.output) as string | undefined,
                    error: sanitizeForLog(bashToolResult?.error) as string | undefined,
                    truncated: bashToolResult?.truncated ?? false,
                    outputBytes: bashToolResult?.outputBytes ?? 0,
                  }
                : {}),
            },
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

    for (const toolUseId of startedToolUseIds) {
      if (finishedToolUseIds.has(toolUseId)) {
        continue;
      }

      const metadata = toolMetadataByUseId.get(toolUseId) ?? {
        toolName: requestedToolByUseId.get(toolUseId)?.toolName ?? "unknown",
        isBash: false,
      };
      const bashToolResult = bashResultByToolUseId.get(toolUseId);
      const progress = progressByToolUseId.get(toolUseId);
      const finishedAtMs = Date.now();
      const startedAtMs = startedAtMsByToolUseId.get(toolUseId);
      const completionSummary = completionSummaryFromMetadata(metadata);
      await onToolFinished({
        summary: completionSummary,
        precedingToolUseIds: [toolUseId],
        ...(metadata.isBash
          ? {
              command: metadata.command,
              shell: "bash" as const,
              isBash: true as const,
              output: bashToolResult?.output,
              error: bashToolResult?.error,
              truncated: bashToolResult?.truncated ?? false,
              outputBytes: bashToolResult?.outputBytes ?? 0,
            }
          : metadata.searchParams
            ? {
                searchParams: metadata.searchParams,
              }
            : {}),
      });
      await emitInstrumentation({
        stage: "finished",
        toolUseId,
        toolName: metadata.toolName,
        parentToolUseId: requestedToolByUseId.get(toolUseId)?.parentToolUseId ?? null,
        summary: completionSummary,
        threadContext: instrumentContext,
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
                output: sanitizeForLog(bashToolResult?.output) as string | undefined,
                error: sanitizeForLog(bashToolResult?.error) as string | undefined,
                truncated: bashToolResult?.truncated ?? false,
                outputBytes: bashToolResult?.outputBytes ?? 0,
              }
            : {}),
        },
      });
      finishedToolUseIds.add(toolUseId);
    }

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
