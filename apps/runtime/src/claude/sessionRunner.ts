import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ClaudeRunner } from "../types";

const MAX_CAPTURED_STDERR_LINES = 12;
const DEFAULT_CLAUDE_EXECUTABLE = "claude";
const COMMON_CLAUDE_EXECUTABLE_PATHS = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
let cachedClaudeExecutable: string | null = null;

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

export const runClaudeWithStreaming: ClaudeRunner = async ({
  prompt,
  sessionId,
  cwd,
  onText,
  onToolStarted,
  onToolOutput,
  onToolFinished,
  onPermissionRequest,
}) => {
  let latestSessionId: string | null = sessionId;
  let finalOutput = "";
  const recentStderr: string[] = [];
  const startedToolUseIds = new Set<string>();

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
        includePartialMessages: true,
        resume: sessionId ?? undefined,
        permissionMode: "default",
        canUseTool: async (toolName, input, options) => {
          const requiresUserApproval = Boolean(
            options.blockedPath || options.decisionReason || (options.suggestions?.length ?? 0) > 0,
          );

          if (!requiresUserApproval) {
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
        if (!startedToolUseIds.has(message.tool_use_id)) {
          startedToolUseIds.add(message.tool_use_id);
          await onToolStarted({
            toolName: message.tool_name,
            toolUseId: message.tool_use_id,
            parentToolUseId: message.parent_tool_use_id,
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
        await onToolFinished({
          summary: message.summary,
          precedingToolUseIds: message.preceding_tool_use_ids,
        });
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
  } catch (error) {
    throw withClaudeSetupHint(error, recentStderr, claudeExecutable);
  }

  return {
    output: finalOutput.trim(),
    sessionId: latestSessionId,
  };
};
