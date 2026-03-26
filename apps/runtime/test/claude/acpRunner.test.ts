import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { __testing } from "../../src/claude/acpRunner";
import { isReviewGitCommand, shouldAutoAllowReviewGitPermission } from "../../src/claude/reviewGitPermissionPolicy";

const defaultInstrumentContext = {
  cwd: "/repo",
  sessionId: "session-1",
  permissionMode: "default" as const,
  autoAcceptTools: false,
  permissionProfile: "default" as const,
};

describe("acpRunner __testing", () => {
  it("builds isolated child env for custom providers with legacy model aliases", () => {
    const baseEnv = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "global-key",
      ANTHROPIC_BASE_URL: "https://global.example.com",
      ANTHROPIC_AUTH_TOKEN: "global-token",
    } as NodeJS.ProcessEnv;

    const env = __testing.buildCustomProviderChildEnv(baseEnv, "/usr/local/bin/claude", {
      providerApiKey: "provider-key",
      providerBaseUrl: "https://provider.example.com/v1/",
      model: "claude-3-7-sonnet",
    });

    expect(env.CLAUDE_CODE_EXECUTABLE).toBe("/usr/local/bin/claude");
    expect(env.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(env.ANTHROPIC_API_KEY).toBe("provider-key");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("provider-key");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://provider.example.com/v1/");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-3-7-sonnet");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-3-7-sonnet");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-3-7-sonnet");
  });

  it("creates an isolated Claude config dir with empty settings", () => {
    const configDir = __testing.ensureIsolatedClaudeConfigDir();
    expect(configDir).toContain("codesymphony-claude-provider");
    expect(existsSync(configDir)).toBe(true);
    expect(readFileSync(`${configDir}/settings.json`, "utf8")).toBe("{}");
  });

  it("ignores generic completion titles", () => {
    expect(__testing.meaningfulCompletionTitle("Completed Task", "Task")).toBe("");
    expect(__testing.meaningfulCompletionTitle("Completed Agent", "Agent")).toBe("");
  });

  it("keeps non-generic completion titles", () => {
    expect(__testing.meaningfulCompletionTitle("Explore Vercel React skill", "Task")).toBe("Explore Vercel React skill");
  });

  it("prefers streamed lastMessage over other fallbacks", () => {
    const result = __testing.resolveSubagentLastMessage(
      {
        agentId: "a1",
        agentType: "Explore",
        toolUseId: "t1",
        launcherToolUseId: null,
        description: "Explore repo",
        lastMessage: "Streamed summary",
        responseFallback: "Fallback title",
      },
      {
        toolCallId: "t1",
        sessionUpdate: "tool_call_update",
        status: "completed",
        title: "Completed Task",
        rawInput: {},
        rawOutput: { result: "Structured result" },
      } as any,
    );

    expect(result).toBe("Streamed summary");
  });

  it("falls back to structured rawOutput when streamed lastMessage is empty", () => {
    const result = __testing.resolveSubagentLastMessage(
      {
        agentId: "a1",
        agentType: "Explore",
        toolUseId: "t1",
        launcherToolUseId: null,
        description: "Explore repo",
        lastMessage: "",
        responseFallback: "",
      },
      {
        toolCallId: "t1",
        sessionUpdate: "tool_call_update",
        status: "completed",
        title: "Completed Task",
        rawInput: {},
        rawOutput: { result: "Structured result" },
      } as any,
    );

    expect(result).toBe("Structured result");
  });

  it("falls back to remembered response/title when structured output is empty", () => {
    const result = __testing.resolveSubagentLastMessage(
      {
        agentId: "a1",
        agentType: "Explore",
        toolUseId: "t1",
        launcherToolUseId: null,
        description: "Explore repo",
        lastMessage: "",
        responseFallback: "Explore Vercel React skill",
      },
      {
        toolCallId: "t1",
        sessionUpdate: "tool_call_update",
        status: "completed",
        title: "Completed Task",
        rawInput: {},
        rawOutput: null,
      } as any,
    );

    expect(result).toBe("Explore Vercel React skill");
  });

  it("matches the review git command allow/deny matrix", () => {
    const allowed = [
      "git status",
      "gh pr create --fill",
      "glab mr create --fill --yes",
      "gh pr create --title \"test\" --body \"$(cat <<'EOF'\nsummary\nEOF\n)\"",
      "glab mr create --title \"test\" --description \"$(cat <<'EOF'\nsummary\nEOF\n)\"",
      "git push && gh pr create --fill",
      "git push && glab mr create --fill --yes",
      "git push && gh pr create --title \"test\" --body \"$(cat <<'EOF'\nsummary\nEOF\n)\"",
      "git push || gh pr create --fill",
      "git push; glab mr create --fill --yes",
    ];
    const denied = [
      "git push && npm test",
      "git status | cat",
      "gh pr create > out.txt",
      "git status `whoami`",
      "git status $(whoami)",
      "git status\ngh pr create --fill",
    ];

    for (const command of allowed) {
      expect(isReviewGitCommand(command)).toBe(true);
    }
    for (const command of denied) {
      expect(isReviewGitCommand(command)).toBe(false);
    }
  });

  it("auto-allows only review_git bash commands in ACP permission flow", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "deny" as const }));
    const client = new __testing.RuntimeAcpClient({
      permissionProfile: "review_git",
      instrumentContext: defaultInstrumentContext,
      onText: () => {},
      onThinking: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onPermissionRequest,
      onPlanFileDetected: () => {},
    });

    const allow = await client.requestPermission({
      toolCall: {
        toolCallId: "tool-review-gh",
        title: "Bash",
        rawInput: { command: "gh pr view --json number,url,headRefName,baseRefName,state" },
        _meta: { claudeCode: { toolName: "Bash" } },
      } as any,
      options: [],
    } as any);

    expect(allow).toEqual({
      outcome: {
        outcome: "selected",
        optionId: "allow",
      },
    });
    expect(onPermissionRequest).not.toHaveBeenCalled();

    const deny = await client.requestPermission({
      toolCall: {
        toolCallId: "tool-review-mixed",
        title: "Bash",
        rawInput: { command: "git push && npm test" },
        _meta: { claudeCode: { toolName: "Bash" } },
      } as any,
      options: [{ optionId: "reject" }],
    } as any);

    expect(deny).toEqual({
      outcome: {
        outcome: "selected",
        optionId: "reject",
      },
    });
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(onPermissionRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "tool-review-mixed",
      toolName: "Bash",
    }));
  });

  it("keeps review commands on permission path outside review_git ACP threads", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "deny" as const }));
    const client = new __testing.RuntimeAcpClient({
      permissionProfile: "default",
      instrumentContext: defaultInstrumentContext,
      onText: () => {},
      onThinking: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onPermissionRequest,
      onPlanFileDetected: () => {},
    });

    const result = await client.requestPermission({
      toolCall: {
        toolCallId: "tool-default-gh",
        title: "Bash",
        rawInput: { command: "gh pr view --json number,url,headRefName,baseRefName,state" },
        _meta: { claudeCode: { toolName: "Bash" } },
      } as any,
      options: [{ optionId: "reject" }],
    } as any);

    expect(result).toEqual({
      outcome: {
        outcome: "selected",
        optionId: "reject",
      },
    });
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(onPermissionRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "tool-default-gh",
      toolName: "Bash",
    }));
  });

  it("gates auto-allow on review_git profile and bash tool", () => {
    expect(shouldAutoAllowReviewGitPermission({
      permissionProfile: "review_git",
      isBash: true,
      command: "gh pr view --json number,url,headRefName,baseRefName,state",
    })).toBe(true);
    expect(shouldAutoAllowReviewGitPermission({
      permissionProfile: "default",
      isBash: true,
      command: "gh pr view --json number,url,headRefName,baseRefName,state",
    })).toBe(false);
    expect(shouldAutoAllowReviewGitPermission({
      permissionProfile: "review_git",
      isBash: false,
      command: "gh pr view --json number,url,headRefName,baseRefName,state",
    })).toBe(false);
  });

  it("extracts permission metadata from ACP claudeCode meta", () => {
    expect(__testing.extractPermissionMetadata({
      title: "Read",
      toolCallId: "tool-1",
      _meta: {
        claudeCode: {
          blockedPath: "/etc/passwd",
          decisionReason: "Restricted path",
        },
      },
    } as any)).toEqual({
      blockedPath: "/etc/passwd",
      decisionReason: "Restricted path",
    });
  });

  it("formats ACP plan entries into markdown content", () => {
    expect(__testing.formatPlanContent([
      { content: "Inspect runtime", status: "completed" },
      { content: "Add ACP tests", status: "in_progress" },
      { content: "Cleanup docs", status: "pending" },
    ])).toBe("# Plan\n\n[x] Inspect runtime\n[-] Add ACP tests\n[ ] Cleanup docs");
  });

  it("forwards permission metadata into runtime permission callback", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "allow" as const }));
    const onToolInstrumentation = vi.fn();
    const client = new __testing.RuntimeAcpClient({
      permissionProfile: "default",
      instrumentContext: defaultInstrumentContext,
      onText: () => {},
      onThinking: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onPermissionRequest,
      onPlanFileDetected: () => {},
      onToolInstrumentation,
    });

    await client.requestPermission({
      toolCall: {
        toolCallId: "tool-meta",
        title: "Read",
        rawInput: { file_path: "/etc/passwd" },
        _meta: {
          claudeCode: {
            toolName: "Read",
            blockedPath: "/etc/passwd",
            decisionReason: "Restricted path",
          },
        },
      } as any,
      options: [{ optionId: "allow" }],
    } as any);

    expect(onPermissionRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "tool-meta",
      blockedPath: "/etc/passwd",
      decisionReason: "Restricted path",
    }));
    expect(onToolInstrumentation).toHaveBeenCalledWith(expect.objectContaining({
      stage: "requested",
      toolUseId: "tool-meta",
      preview: expect.objectContaining({
        blockedPath: "/etc/passwd",
        decisionReason: "Restricted path",
        suggestionsCount: 1,
      }),
    }));
    expect(onToolInstrumentation).toHaveBeenCalledWith(expect.objectContaining({
      stage: "decision",
      toolUseId: "tool-meta",
      decision: "allow",
    }));
  });

  it("emits plan detection for ACP plan updates", async () => {
    const onPlanFileDetected = vi.fn();
    const client = new __testing.RuntimeAcpClient({
      permissionProfile: "default",
      instrumentContext: defaultInstrumentContext,
      onText: () => {},
      onThinking: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onPermissionRequest: async () => ({ decision: "deny" as const }),
      onPlanFileDetected,
    });

    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Review ACP parity", status: "pending", priority: "high" },
          { content: "Write tests", status: "in_progress", priority: "medium" },
        ],
      } as any,
    });

    expect(onPlanFileDetected).toHaveBeenCalledWith({
      filePath: ".claude/plans/acp-plan.md",
      content: "# Plan\n\n[ ] Review ACP parity\n[-] Write tests",
      source: "streaming_fallback",
    });
  });

  it("emits available commands updates from ACP session events", async () => {
    const onAvailableCommandsUpdated = vi.fn();
    const client = new __testing.RuntimeAcpClient({
      permissionProfile: "default",
      instrumentContext: defaultInstrumentContext,
      onText: () => {},
      onThinking: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onPermissionRequest: async () => ({ decision: "deny" as const }),
      onPlanFileDetected: () => {},
      onAvailableCommandsUpdated,
    });

    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "commit", description: "Create a git commit", input: { hint: "-m 'msg'" } },
          { name: "review-pr", description: "Review the current PR" },
        ],
      } as any,
    });

    expect(onAvailableCommandsUpdated).toHaveBeenCalledWith({
      availableCommands: [
        { name: "commit", description: "Create a git commit", input: { hint: "-m 'msg'" } },
        { name: "review-pr", description: "Review the current PR" },
      ],
    });
  });

  it("emits instrumentation for tool lifecycle events", async () => {
    const onToolInstrumentation = vi.fn();
    const onToolStarted = vi.fn();
    const onToolFinished = vi.fn();
    const client = new __testing.RuntimeAcpClient({
      permissionProfile: "default",
      instrumentContext: defaultInstrumentContext,
      onText: () => {},
      onThinking: () => {},
      onToolStarted,
      onToolOutput: () => {},
      onToolFinished,
      onPermissionRequest: async () => ({ decision: "deny" as const }),
      onPlanFileDetected: () => {},
      onAvailableCommandsUpdated: () => {},
      onToolInstrumentation,
    });

    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-read",
        title: "Read file",
        rawInput: { file_path: "/repo/README.md" },
        _meta: { claudeCode: { toolName: "Read" } },
      } as any,
    });

    await client.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-read",
        status: "completed",
        title: "Read README.md",
        rawInput: { file_path: "/repo/README.md" },
        rawOutput: "done",
        _meta: { claudeCode: { toolName: "Read" } },
      } as any,
    });

    expect(onToolStarted).toHaveBeenCalledWith(expect.objectContaining({
      toolUseId: "tool-read",
      toolName: "Read",
    }));
    expect(onToolFinished).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "Read",
      precedingToolUseIds: ["tool-read"],
      summary: "Read README.md",
    }));
    expect(onToolInstrumentation).toHaveBeenCalledWith(expect.objectContaining({
      stage: "started",
      toolUseId: "tool-read",
      toolName: "Read",
    }));
    expect(onToolInstrumentation).toHaveBeenCalledWith(expect.objectContaining({
      stage: "finished",
      toolUseId: "tool-read",
      summary: "Read README.md",
    }));
  });
});
