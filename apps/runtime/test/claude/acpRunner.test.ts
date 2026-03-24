import { describe, expect, it } from "vitest";
import { __testing } from "../../src/claude/acpRunner";

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
});
