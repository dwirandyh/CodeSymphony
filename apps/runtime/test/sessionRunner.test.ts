import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptStepRunner } from "../src/types";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

type SdkMessage = {
  type: "system" | "assistant" | "stream_event";
  subtype?: "init";
  session_id?: string;
  message?: {
    content: Array<
      | { type: "text"; text: string }
      | { type: string; [key: string]: unknown }
    >;
  };
  event?: {
    type: string;
    delta?: {
      type: string;
      text?: string;
    };
  };
};

function createMessageStream(messages: SdkMessage[]) {
  return (async function* () {
    for (const message of messages) {
      yield message;
    }
  })();
}

describe("sessionRunner", () => {
  let runPromptStepWithClaude: PromptStepRunner;

  beforeEach(async () => {
    vi.resetModules();
    queryMock.mockReset();
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue("/opt/homebrew/bin/claude\n");
    ({ runPromptStepWithClaude } = await import("../src/claude/sessionRunner"));
  });

  it("passes user setting sources and sanitized env to SDK query", async () => {
    const originalClaudeCode = process.env.CLAUDECODE;
    const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

    try {
      process.env.CLAUDECODE = "1";
      process.env.CLAUDE_CODE_EXECUTABLE = "/custom/bin/claude";
      process.env.ANTHROPIC_API_KEY = "should-not-be-used";
      process.env.ANTHROPIC_BASE_URL = "https://example.invalid";

      queryMock.mockReturnValue(
        createMessageStream([
          { type: "system", subtype: "init", session_id: "session-1" },
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "hello world" }],
            },
          },
        ]),
      );

      const result = await runPromptStepWithClaude({
        prompt: "Summarize task",
        sessionId: null,
        onLog: vi.fn(),
      });

      expect(result).toEqual({
        output: "hello world",
        sessionId: "session-1",
      });

      expect(queryMock).toHaveBeenCalledTimes(1);
      const call = queryMock.mock.calls[0]?.[0];
      expect(call.prompt).toBe("Summarize task");
      expect(call.options.settingSources).toEqual(["user"]);
      expect(call.options.permissionMode).toBe("acceptEdits");
      expect(call.options.pathToClaudeCodeExecutable).toBe("/custom/bin/claude");
      expect(call.options.env.CLAUDECODE).toBeUndefined();
      expect(call.options.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(call.options.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(typeof call.options.stderr).toBe("function");
      expect(execFileSyncMock).not.toHaveBeenCalled();
    } finally {
      process.env.CLAUDECODE = originalClaudeCode;
      process.env.CLAUDE_CODE_EXECUTABLE = originalExecutable;
      process.env.ANTHROPIC_API_KEY = originalApiKey;
      process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    }
  });

  it("resolves command names like 'claude' to absolute paths before SDK query", async () => {
    const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;

    try {
      process.env.CLAUDE_CODE_EXECUTABLE = "claude";

      queryMock.mockReturnValue(
        createMessageStream([
          { type: "system", subtype: "init", session_id: "session-1" },
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "hello world" }],
            },
          },
        ]),
      );

      await runPromptStepWithClaude({
        prompt: "Summarize task",
        sessionId: null,
        onLog: vi.fn(),
      });

      const call = queryMock.mock.calls[0]?.[0];
      expect(execFileSyncMock).toHaveBeenCalledWith("which", ["claude"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      expect(call.options.pathToClaudeCodeExecutable).toBe("/opt/homebrew/bin/claude");
    } finally {
      process.env.CLAUDE_CODE_EXECUTABLE = originalExecutable;
    }
  });

  it("adds actionable setup hint for exit-code-1 SDK failures", async () => {
    queryMock.mockImplementation((args: { options: { stderr?: (data: string) => void } }) => {
      args.options.stderr?.("auth failed");

      return (async function* () {
        throw new Error("Claude Code process exited with code 1");
      })();
    });

    await expect(
      runPromptStepWithClaude({
        prompt: "Summarize task",
        sessionId: null,
        onLog: vi.fn(),
      }),
    ).rejects.toThrow(/installed Claude Code CLI/);

    await expect(
      runPromptStepWithClaude({
        prompt: "Summarize task",
        sessionId: null,
        onLog: vi.fn(),
      }),
    ).rejects.toThrow(/Recent Claude stderr:\nauth failed/);
  });
});
