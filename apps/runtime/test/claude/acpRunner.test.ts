import { describe, expect, it, vi } from "vitest";
import { __testing } from "../../src/claude/acpRunner";
import { isReviewGitCommand, shouldAutoAllowReviewGitPermission } from "../../src/claude/reviewGitPermissionPolicy";

describe("acpRunner __testing", () => {
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
});
