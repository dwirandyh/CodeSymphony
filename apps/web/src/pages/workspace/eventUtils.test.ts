import { describe, it, expect } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import {
  payloadStringOrNull,
  payloadStringArray,
  isRecord,
  isClaudePlanFilePayload,
  isPlanFilePath,
  isPlanModeToolEvent,
  isBashPayload,
  isBashToolEvent,
  isExploreLikeBashCommand,
  isExploreLikeBashEvent,
  isWorktreeDiffEvent,
  isMetadataToolEvent,
  eventPayloadText,
  isReadToolEvent,
  isSearchToolEvent,
  findRepositoryByWorktree,
  parseTimestamp,
  getEventMessageId,
  getCompletedMessageId,
  shouldClearWaitingAssistantOnEvent,
  extractFirstFilePath,
  promptLooksLikeFileRead,
  hasUnclosedCodeFence,
  isLikelyDiffContent,
  filterDiffByFiles,
  countDiffStats,
  activityStepLabel,
  toolEventDetail,
  buildActivitySteps,
  computeDurationSecondsFromEvents,
  buildActivityIntroText,
  finishedToolUseIds,
} from "./eventUtils";

function makeEvent(overrides: Partial<ChatEvent> & { type: ChatEvent["type"] }): ChatEvent {
  return {
    id: "evt-1",
    threadId: "thread-1",
    idx: 0,
    payload: {},
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── Payload helpers ──

describe("payloadStringOrNull", () => {
  it("returns string for non-empty string", () => {
    expect(payloadStringOrNull("hello")).toBe("hello");
  });

  it("returns null for empty string", () => {
    expect(payloadStringOrNull("")).toBeNull();
  });

  it("returns null for non-string", () => {
    expect(payloadStringOrNull(123)).toBeNull();
    expect(payloadStringOrNull(null)).toBeNull();
    expect(payloadStringOrNull(undefined)).toBeNull();
  });
});

describe("payloadStringArray", () => {
  it("filters to non-empty strings", () => {
    expect(payloadStringArray(["a", "", "b", 123, null])).toEqual(["a", "b"]);
  });

  it("returns empty for non-array", () => {
    expect(payloadStringArray("hello")).toEqual([]);
    expect(payloadStringArray(null)).toEqual([]);
  });
});

describe("isRecord", () => {
  it("returns true for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ key: "value" })).toBe(true);
  });

  it("returns false for non-objects", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("string")).toBe(false);
    expect(isRecord(42)).toBe(false);
  });
});

// ── Event classification ──

describe("isClaudePlanFilePayload", () => {
  it("returns true for claude_plan_file source", () => {
    expect(isClaudePlanFilePayload({ source: "claude_plan_file" })).toBe(true);
  });

  it("returns true for streaming_fallback source", () => {
    expect(isClaudePlanFilePayload({ source: "streaming_fallback" })).toBe(true);
  });

  it("returns true for plan file path", () => {
    expect(isClaudePlanFilePayload({ source: "other", filePath: "/project/.claude/plans/plan.md" })).toBe(true);
  });

  it("returns false for non-plan payload", () => {
    expect(isClaudePlanFilePayload({ source: "other", filePath: "/project/src/index.ts" })).toBe(false);
  });
});

describe("isPlanFilePath", () => {
  it("returns true for .claude/plans path", () => {
    expect(isPlanFilePath("/project/.claude/plans/plan.md")).toBe(true);
  });

  it("returns true for codesymphony-claude-provider/plans path", () => {
    expect(isPlanFilePath("/tmp/codesymphony-claude-provider/plans/plan.md")).toBe(true);
  });

  it("returns false for non-plan paths", () => {
    expect(isPlanFilePath("/project/src/index.md")).toBe(false);
    expect(isPlanFilePath("/project/.claude/plans/plan.ts")).toBe(false);
  });
});

describe("isPlanModeToolEvent", () => {
  it("returns true for exitplanmode tool", () => {
    const event = makeEvent({ type: "tool.started", payload: { toolName: "ExitPlanMode" } });
    expect(isPlanModeToolEvent(event)).toBe(true);
  });

  it("returns true for edit tool on plan file", () => {
    const event = makeEvent({
      type: "tool.started",
      payload: { toolName: "edit", filePath: "/project/.claude/plans/plan.md" },
    });
    expect(isPlanModeToolEvent(event)).toBe(true);
  });

  it("returns false for regular tool", () => {
    const event = makeEvent({ type: "tool.started", payload: { toolName: "bash" } });
    expect(isPlanModeToolEvent(event)).toBe(false);
  });
});

describe("isBashPayload", () => {
  it("returns true when isBash is true", () => {
    expect(isBashPayload({ isBash: true })).toBe(true);
  });

  it("returns true when shell is bash", () => {
    expect(isBashPayload({ shell: "bash" })).toBe(true);
  });

  it("returns true when toolName is bash", () => {
    expect(isBashPayload({ toolName: "Bash" })).toBe(true);
  });

  it("returns false for other tools", () => {
    expect(isBashPayload({ toolName: "edit" })).toBe(false);
    expect(isBashPayload({})).toBe(false);
  });
});

describe("isBashToolEvent", () => {
  it("returns true for bash tool.started", () => {
    expect(isBashToolEvent(makeEvent({ type: "tool.started", payload: { toolName: "bash" } }))).toBe(true);
  });

  it("returns false for non-tool events", () => {
    expect(isBashToolEvent(makeEvent({ type: "message.delta", payload: { toolName: "bash" } }))).toBe(false);
  });
});

describe("isExploreLikeBashCommand", () => {
  it("returns true for ls", () => {
    expect(isExploreLikeBashCommand("ls -la")).toBe(true);
  });

  it("returns true for find", () => {
    expect(isExploreLikeBashCommand("find . -name '*.ts'")).toBe(true);
  });

  it("returns true for grep", () => {
    expect(isExploreLikeBashCommand("grep -r pattern")).toBe(true);
  });

  it("returns true for rg", () => {
    expect(isExploreLikeBashCommand("rg pattern")).toBe(true);
  });

  it("returns false for non-explore commands", () => {
    expect(isExploreLikeBashCommand("npm install")).toBe(false);
  });

  it("returns false for null/empty", () => {
    expect(isExploreLikeBashCommand(null)).toBe(false);
    expect(isExploreLikeBashCommand("")).toBe(false);
    expect(isExploreLikeBashCommand("  ")).toBe(false);
  });
});

describe("isExploreLikeBashEvent", () => {
  it("returns true for bash event with explore command", () => {
    const event = makeEvent({ type: "tool.started", payload: { toolName: "bash", command: "ls -la" } });
    expect(isExploreLikeBashEvent(event)).toBe(true);
  });

  it("returns false for non-bash event", () => {
    const event = makeEvent({ type: "tool.started", payload: { toolName: "edit", command: "ls" } });
    expect(isExploreLikeBashEvent(event)).toBe(false);
  });
});

describe("isWorktreeDiffEvent", () => {
  it("returns true for worktree.diff tool.finished", () => {
    expect(isWorktreeDiffEvent(makeEvent({ type: "tool.finished", payload: { source: "worktree.diff" } }))).toBe(true);
  });

  it("returns false for other events", () => {
    expect(isWorktreeDiffEvent(makeEvent({ type: "tool.finished", payload: { source: "other" } }))).toBe(false);
    expect(isWorktreeDiffEvent(makeEvent({ type: "tool.started", payload: { source: "worktree.diff" } }))).toBe(false);
  });
});

describe("isMetadataToolEvent", () => {
  it("returns true for metadata source", () => {
    expect(isMetadataToolEvent(makeEvent({ type: "tool.finished", payload: { source: "chat.thread.metadata" } }))).toBe(true);
  });
});

describe("eventPayloadText", () => {
  it("serializes payload as lowercase JSON", () => {
    expect(eventPayloadText(makeEvent({ type: "tool.started", payload: { toolName: "Bash" } }))).toBe('{"toolname":"bash"}');
  });
});

describe("isReadToolEvent", () => {
  it("returns true for read tool", () => {
    const event = makeEvent({ type: "tool.finished", payload: { toolName: "Read" } });
    expect(isReadToolEvent(event)).toBe(true);
  });

  it("returns false for bash event even if payload says read", () => {
    const event = makeEvent({ type: "tool.finished", payload: { toolName: "bash", isBash: true, summary: "read file" } });
    expect(isReadToolEvent(event)).toBe(false);
  });

  it("returns false for permission.requested", () => {
    const event = makeEvent({ type: "permission.requested", payload: { toolName: "Read" } });
    expect(isReadToolEvent(event)).toBe(false);
  });
});

describe("isSearchToolEvent", () => {
  it("returns true for glob tool", () => {
    const event = makeEvent({ type: "tool.finished", payload: { toolName: "Glob" } });
    expect(isSearchToolEvent(event)).toBe(true);
  });

  it("returns false for read tool events", () => {
    const event = makeEvent({ type: "tool.finished", payload: { toolName: "Read" } });
    expect(isSearchToolEvent(event)).toBe(false);
  });

  it("returns false for bash events", () => {
    const event = makeEvent({ type: "tool.finished", payload: { toolName: "bash", isBash: true } });
    expect(isSearchToolEvent(event)).toBe(false);
  });
});

// ── Event data extraction ──

describe("findRepositoryByWorktree", () => {
  const repos = [
    { id: "r1", name: "Repo1", rootPath: "/a", worktrees: [{ id: "w1" }, { id: "w2" }] },
    { id: "r2", name: "Repo2", rootPath: "/b", worktrees: [{ id: "w3" }] },
  ] as any;

  it("finds repository containing worktree", () => {
    expect(findRepositoryByWorktree(repos, "w3")?.id).toBe("r2");
  });

  it("returns null for unknown worktree", () => {
    expect(findRepositoryByWorktree(repos, "w999")).toBeNull();
  });

  it("returns null for null worktreeId", () => {
    expect(findRepositoryByWorktree(repos, null)).toBeNull();
  });
});

describe("parseTimestamp", () => {
  it("parses valid ISO timestamp", () => {
    expect(parseTimestamp("2025-01-01T00:00:00.000Z")).toBe(1735689600000);
  });

  it("returns null for invalid string", () => {
    expect(parseTimestamp("not-a-date")).toBeNull();
  });
});

describe("getEventMessageId", () => {
  it("returns messageId for message.delta", () => {
    const event = makeEvent({ type: "message.delta", payload: { messageId: "msg-1" } });
    expect(getEventMessageId(event)).toBe("msg-1");
  });

  it("returns messageId for thinking.delta", () => {
    const event = makeEvent({ type: "thinking.delta", payload: { messageId: "msg-2" } });
    expect(getEventMessageId(event)).toBe("msg-2");
  });

  it("returns null for other event types", () => {
    expect(getEventMessageId(makeEvent({ type: "tool.started", payload: { messageId: "msg-1" } }))).toBeNull();
  });

  it("returns null for empty messageId", () => {
    expect(getEventMessageId(makeEvent({ type: "message.delta", payload: { messageId: "" } }))).toBeNull();
  });
});

describe("getCompletedMessageId", () => {
  it("returns messageId for chat.completed", () => {
    const event = makeEvent({ type: "chat.completed", payload: { messageId: "msg-1" } });
    expect(getCompletedMessageId(event)).toBe("msg-1");
  });

  it("returns null for non-completed events", () => {
    expect(getCompletedMessageId(makeEvent({ type: "message.delta", payload: { messageId: "msg-1" } }))).toBeNull();
  });
});

describe("shouldClearWaitingAssistantOnEvent", () => {
  it("returns true for chat.completed", () => {
    expect(shouldClearWaitingAssistantOnEvent(makeEvent({ type: "chat.completed" }))).toBe(true);
  });

  it("returns true for chat.failed", () => {
    expect(shouldClearWaitingAssistantOnEvent(makeEvent({ type: "chat.failed" }))).toBe(true);
  });

  it("returns true for assistant message.delta", () => {
    expect(shouldClearWaitingAssistantOnEvent(makeEvent({ type: "message.delta", payload: { role: "assistant" } }))).toBe(true);
  });

  it("returns false for user message.delta", () => {
    expect(shouldClearWaitingAssistantOnEvent(makeEvent({ type: "message.delta", payload: { role: "user" } }))).toBe(false);
  });

  it("returns true for thinking.delta", () => {
    expect(shouldClearWaitingAssistantOnEvent(makeEvent({ type: "thinking.delta" }))).toBe(true);
  });

  it("returns true for permission.requested", () => {
    expect(shouldClearWaitingAssistantOnEvent(makeEvent({ type: "permission.requested" }))).toBe(true);
  });

  it("returns true for question.requested", () => {
    expect(shouldClearWaitingAssistantOnEvent(makeEvent({ type: "question.requested" }))).toBe(true);
  });

  it("returns false for tool events", () => {
    expect(shouldClearWaitingAssistantOnEvent(makeEvent({ type: "tool.started" }))).toBe(false);
  });
});

// ── Content helpers ──

describe("extractFirstFilePath", () => {
  it("extracts file path from text", () => {
    expect(extractFirstFilePath("Look at src/index.ts for details")).toBe("src/index.ts");
  });

  it("extracts paths with deep nesting", () => {
    expect(extractFirstFilePath("Edit apps/web/src/lib/api.ts")).toBe("apps/web/src/lib/api.ts");
  });

  it("returns null for no paths", () => {
    expect(extractFirstFilePath("no file paths here")).toBeNull();
  });
});

describe("promptLooksLikeFileRead", () => {
  it("returns true for read prompt with file path", () => {
    expect(promptLooksLikeFileRead("read src/index.ts")).toBe(true);
  });

  it("returns true for show prompt", () => {
    expect(promptLooksLikeFileRead("show me the file src/app.tsx")).toBe(true);
  });

  it("returns false for non-read prompt", () => {
    expect(promptLooksLikeFileRead("create a new component")).toBe(false);
  });
});

describe("hasUnclosedCodeFence", () => {
  it("returns false for no code fences", () => {
    expect(hasUnclosedCodeFence("Hello world")).toBe(false);
  });

  it("returns true for unclosed fence", () => {
    expect(hasUnclosedCodeFence("```typescript\nconst x = 1;")).toBe(true);
  });

  it("returns false for closed fence", () => {
    expect(hasUnclosedCodeFence("```typescript\nconst x = 1;\n```")).toBe(false);
  });

  it("returns true for odd number of fences", () => {
    expect(hasUnclosedCodeFence("```\ncode\n```\n```\nmore")).toBe(true);
  });
});

describe("isLikelyDiffContent", () => {
  it("returns true for diff header", () => {
    expect(isLikelyDiffContent("diff --git a/file.ts b/file.ts")).toBe(true);
  });

  it("returns true for --- line", () => {
    expect(isLikelyDiffContent("--- a/file.ts")).toBe(true);
  });

  it("returns true for @@ hunk header", () => {
    expect(isLikelyDiffContent("@@ -1,3 +1,4 @@")).toBe(true);
  });

  it("returns false for regular text", () => {
    expect(isLikelyDiffContent("This is just text")).toBe(false);
  });
});

// ── Diff helpers ──

describe("filterDiffByFiles", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "+new line",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "+another line",
  ].join("\n");

  it("filters to specified files", () => {
    const result = filterDiffByFiles(diff, ["src/a.ts"]);
    expect(result).toContain("src/a.ts");
    expect(result).not.toContain("src/b.ts");
  });

  it("returns full diff for empty file list", () => {
    expect(filterDiffByFiles(diff, [])).toBe(diff);
  });

  it("returns full diff for empty diff", () => {
    expect(filterDiffByFiles("", ["src/a.ts"])).toBe("");
  });
});

describe("countDiffStats", () => {
  it("counts additions and deletions", () => {
    const diff = "--- a/file\n+++ b/file\n+new line\n-old line\n+another new";
    expect(countDiffStats(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  it("ignores diff headers", () => {
    const diff = "--- a/file\n+++ b/file\n context line";
    expect(countDiffStats(diff)).toEqual({ additions: 0, deletions: 0 });
  });

  it("handles empty diff", () => {
    expect(countDiffStats("")).toEqual({ additions: 0, deletions: 0 });
  });
});

// ── Activity step helpers ──

describe("activityStepLabel", () => {
  it("returns Error for chat.failed", () => {
    expect(activityStepLabel(makeEvent({ type: "chat.failed", payload: { message: "oops" } }), "")).toBe("Error");
  });

  it("returns Permission for permission.requested", () => {
    expect(activityStepLabel(makeEvent({ type: "permission.requested" }), "")).toBe("Permission");
  });

  it("returns Permission for permission.resolved", () => {
    expect(activityStepLabel(makeEvent({ type: "permission.resolved" }), "")).toBe("Permission");
  });

  it("returns Analyzed for read tool events", () => {
    expect(activityStepLabel(makeEvent({ type: "tool.finished", payload: { toolName: "Read" } }), "Read file.ts")).toBe("Analyzed");
  });

  it("returns Searched for search tool events", () => {
    expect(activityStepLabel(makeEvent({ type: "tool.finished", payload: { toolName: "Glob" } }), "Glob pattern")).toBe("Searched");
  });

  it("returns Warning for integrity warning", () => {
    expect(activityStepLabel(makeEvent({ type: "tool.finished", payload: { source: "integrity.warning" } }), "")).toBe("Warning");
  });

  it("returns MCP Tool for mcp tools", () => {
    expect(activityStepLabel(makeEvent({ type: "tool.finished", payload: { toolName: "mcp_tool" } }), "mcp stuff")).toBe("MCP Tool");
  });

  it("returns Step for unknown tool events", () => {
    expect(activityStepLabel(makeEvent({ type: "tool.finished", payload: { toolName: "custom_tool" } }), "custom_tool")).toBe("Step");
  });
});

describe("toolEventDetail", () => {
  it("returns message for chat.failed", () => {
    expect(toolEventDetail(makeEvent({ type: "chat.failed", payload: { message: "Error occurred" } }))).toBe("Error occurred");
  });

  it("returns default message for chat.failed without message", () => {
    expect(toolEventDetail(makeEvent({ type: "chat.failed", payload: {} }))).toBe("Chat failed");
  });

  it("returns Permission requested for permission.requested", () => {
    expect(toolEventDetail(makeEvent({ type: "permission.requested" }))).toBe("Permission requested");
  });

  it("returns allow details for permission.resolved", () => {
    expect(toolEventDetail(makeEvent({ type: "permission.resolved", payload: { decision: "allow" } }))).toBe("Permission allowed");
    expect(toolEventDetail(makeEvent({ type: "permission.resolved", payload: { decision: "allow_always" } }))).toBe("Permission allowed (always)");
    expect(toolEventDetail(makeEvent({ type: "permission.resolved", payload: { decision: "deny" } }))).toBe("Permission denied");
    expect(toolEventDetail(makeEvent({ type: "permission.resolved", payload: { decision: "other" } }))).toBe("Permission resolved");
  });

  it("returns summary for tool.finished", () => {
    expect(toolEventDetail(makeEvent({ type: "tool.finished", payload: { summary: "Edited file.ts" } }))).toBe("Edited file.ts");
  });

  it("returns running status for tool.started", () => {
    expect(toolEventDetail(makeEvent({ type: "tool.started", payload: { toolName: "Bash" } }))).toBe("Bash (running)");
  });

  it("returns elapsed time for tool.output", () => {
    expect(toolEventDetail(makeEvent({ type: "tool.output", payload: { toolName: "Bash", elapsedTimeSeconds: 3.14 } }))).toBe("Bash (3.1s)");
  });

  it("returns Tool step as fallback", () => {
    expect(toolEventDetail(makeEvent({ type: "tool.output", payload: {} }))).toBe("Tool step");
  });

  it("returns command when no tool name", () => {
    expect(toolEventDetail(makeEvent({ type: "tool.output", payload: { command: "npm install" } }))).toBe("npm install");
  });
});

describe("buildActivitySteps", () => {
  it("returns empty array for empty events", () => {
    expect(buildActivitySteps([])).toEqual([]);
  });

  it("builds steps from tool events", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Bash", toolUseId: "t1" } }),
      makeEvent({ id: "e2", type: "tool.finished", idx: 2, payload: { toolName: "Bash", summary: "Done", precedingToolUseIds: ["t1"] } }),
    ];
    const steps = buildActivitySteps(events);
    expect(steps.length).toBe(1);
    expect(steps[0].detail).toBe("Done");
  });

  it("deduplicates by tool use ID with priority", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Read", toolUseId: "t1" } }),
      makeEvent({ id: "e2", type: "tool.output", idx: 2, payload: { toolName: "Read", toolUseId: "t1" } }),
      makeEvent({ id: "e3", type: "tool.finished", idx: 3, payload: { summary: "Read file", precedingToolUseIds: ["t1"] } }),
    ];
    const steps = buildActivitySteps(events);
    expect(steps.length).toBe(1);
    expect(steps[0].detail).toBe("Read file");
  });

  it("includes chat.failed events", () => {
    const events = [
      makeEvent({ id: "e1", type: "chat.failed", idx: 1, payload: { message: "Oops" } }),
    ];
    const steps = buildActivitySteps(events);
    expect(steps.length).toBe(1);
    expect(steps[0].label).toBe("Error");
  });
});

describe("computeDurationSecondsFromEvents", () => {
  it("returns 0 for empty events", () => {
    expect(computeDurationSecondsFromEvents([])).toBe(0);
  });

  it("computes duration from timestamps", () => {
    const events = [
      makeEvent({ type: "tool.started", createdAt: "2025-01-01T00:00:00.000Z" }),
      makeEvent({ type: "tool.finished", createdAt: "2025-01-01T00:00:10.000Z" }),
    ];
    expect(computeDurationSecondsFromEvents(events)).toBe(10);
  });

  it("falls back to elapsed time seconds", () => {
    const events = [
      makeEvent({ type: "tool.output", payload: { elapsedTimeSeconds: 5.5 } }),
    ];
    expect(computeDurationSecondsFromEvents(events)).toBe(6);
  });

  it("returns 1 as minimum", () => {
    const events = [
      makeEvent({ type: "tool.started", createdAt: "2025-01-01T00:00:00.000Z" }),
      makeEvent({ type: "tool.finished", createdAt: "2025-01-01T00:00:00.500Z" }),
    ];
    expect(computeDurationSecondsFromEvents(events)).toBe(1);
  });
});

describe("buildActivityIntroText", () => {
  it("returns null for empty content", () => {
    expect(buildActivityIntroText("")).toBeNull();
    expect(buildActivityIntroText("   ")).toBeNull();
  });

  it("returns first two sentences", () => {
    expect(buildActivityIntroText("First sentence. Second sentence. Third sentence.")).toBe("First sentence. Second sentence.");
  });

  it("truncates long text at 220 chars", () => {
    const long = "A".repeat(300);
    const result = buildActivityIntroText(long);
    expect(result!.length).toBeLessThanOrEqual(220);
    expect(result!.endsWith("...")).toBe(true);
  });

  it("normalizes whitespace", () => {
    expect(buildActivityIntroText("  hello   world  ")).toBe("hello world");
  });
});

describe("finishedToolUseIds", () => {
  it("returns precedingToolUseIds if available", () => {
    const event = makeEvent({ type: "tool.finished", payload: { precedingToolUseIds: ["t1", "t2"] } });
    expect(finishedToolUseIds(event)).toEqual(["t1", "t2"]);
  });

  it("returns toolUseId as fallback", () => {
    const event = makeEvent({ type: "tool.finished", payload: { toolUseId: "t1" } });
    expect(finishedToolUseIds(event)).toEqual(["t1"]);
  });

  it("returns finished:eventId as last fallback", () => {
    const event = makeEvent({ id: "e1", type: "tool.finished", payload: {} });
    expect(finishedToolUseIds(event)).toEqual(["finished:e1"]);
  });

  it("filters empty strings from precedingToolUseIds", () => {
    const event = makeEvent({ type: "tool.finished", payload: { precedingToolUseIds: ["t1", "", "t2"] } });
    expect(finishedToolUseIds(event)).toEqual(["t1", "t2"]);
  });
});
