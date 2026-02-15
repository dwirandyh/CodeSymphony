import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import type { ClaudeRunner } from "../types";

const MAX_CAPTURED_STDERR_LINES = 12;
const DEFAULT_CLAUDE_EXECUTABLE = "claude";

function resolveExecutablePath(commandOrPath: string): string {
  if (commandOrPath.includes("/")) {
    return commandOrPath;
  }

  try {
    const resolved = execFileSync("which", [commandOrPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (resolved.length > 0) {
      return resolved;
    }
  } catch {
    // Fall through and let SDK report a clear executable-not-found error.
  }

  return commandOrPath;
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
}) => {
  let latestSessionId: string | null = sessionId;
  let finalOutput = "";
  const recentStderr: string[] = [];
  const startedToolUseIds = new Set<string>();

  const configuredExecutable = process.env.CLAUDE_CODE_EXECUTABLE?.trim() || DEFAULT_CLAUDE_EXECUTABLE;
  const claudeExecutable = resolveExecutablePath(configuredExecutable);

  const runtimeEnv = {
    ...process.env,
  } as NodeJS.ProcessEnv;

  delete runtimeEnv.CLAUDECODE;
  delete runtimeEnv.ANTHROPIC_API_KEY;
  delete runtimeEnv.ANTHROPIC_BASE_URL;

  try {
    const stream = query({
      prompt,
      options: {
        includePartialMessages: true,
        resume: sessionId ?? undefined,
        permissionMode: "acceptEdits",
        pathToClaudeCodeExecutable: claudeExecutable,
        settingSources: ["user"],
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
