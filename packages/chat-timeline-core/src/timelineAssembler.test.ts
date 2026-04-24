import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatMessage, ChatTimelineItem } from "@codesymphony/shared-types";
import { buildTimelineFromSeed } from "./timelineAssembler.js";

function makeMessage(id: string, seq: number, role: "user" | "assistant", content: string): ChatMessage {
  return {
    id,
    threadId: "t1",
    seq,
    role,
    content,
    attachments: [],
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function makeEvent(
  idx: number,
  type: ChatEvent["type"],
  payload: Record<string, unknown>,
): ChatEvent {
  return {
    id: `e-${idx}`,
    threadId: "t1",
    idx,
    type,
    payload,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("buildTimelineFromSeed", () => {
  it("does not leak orphan subagent-linked tool events into the main timeline", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Investigate this project."),
      makeMessage("m2", 1, "assistant", "Done."),
    ];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Task",
        toolUseId: "task-1",
      }),
      makeEvent(1, "subagent.started", {
        agentId: "agent-1",
        agentType: "Explore",
        toolUseId: "subagent-1",
        description: "Inspecting files",
      }),
      makeEvent(2, "tool.started", {
        toolName: "Bash",
        toolUseId: "bash-1",
        launcherToolUseId: "task-1",
        ownershipReason: "unresolved_ambiguous_candidates",
        toolInput: { command: "ls" },
      }),
      makeEvent(3, "tool.finished", {
        toolName: "Bash",
        summary: "Ran ls",
        launcherToolUseId: "task-1",
        ownershipReason: "unresolved_ambiguous_candidates",
        precedingToolUseIds: ["bash-1"],
      }),
      makeEvent(4, "subagent.finished", {
        toolUseId: "subagent-1",
        description: "Inspecting files",
        lastMessage: "Found the relevant files.",
      }),
      makeEvent(5, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "Done.",
      }),
      makeEvent(6, "chat.completed", { messageId: "m2" }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    expect(result.items.some((item) => item.kind === "tool" && item.toolName === "Bash")).toBe(false);
    expect(result.items.some((item) => item.kind === "subagent-activity")).toBe(true);
  });

  it("keeps AskUserQuestion question lifecycle events attached to the orphan tool card", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Ask me 3 questions first."),
      makeMessage("m2", 1, "assistant", "Understood: concise, speed-focused, and formal."),
    ];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "AskUserQuestion",
        toolUseId: "call-1",
      }),
      makeEvent(1, "question.requested", {
        requestId: "call-1",
        questions: [
          { question: "Q1?" },
          { question: "Q2?" },
          { question: "Q3?" },
        ],
      }),
      makeEvent(2, "question.answered", {
        requestId: "call-1",
        answers: {
          "Q1?": "A1",
          "Q2?": "A2",
          "Q3?": "A3",
        },
      }),
      makeEvent(3, "tool.finished", {
        toolName: "AskUserQuestion",
        summary: "Completed AskUserQuestion",
        precedingToolUseIds: ["call-1"],
      }),
      makeEvent(4, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "Understood: concise, speed-focused, and formal.",
      }),
      makeEvent(5, "chat.completed", { messageId: "m2" }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const askUserQuestionItem = result.items.find(
      (item): item is Extract<ChatTimelineItem, { kind: "tool" }> =>
        item.kind === "tool" && item.toolName === "AskUserQuestion",
    );
    expect(askUserQuestionItem).toMatchObject({
      kind: "tool",
      toolName: "AskUserQuestion",
      summary: "Asked 3 Questions",
    });
    expect(askUserQuestionItem?.sourceEvents?.map((event: ChatEvent) => event.type)).toEqual([
      "tool.started",
      "question.requested",
      "question.answered",
      "tool.finished",
    ]);
    expect(result.items.some((item) => item.kind === "activity")).toBe(false);
  });

  it("keeps streaming fenced markdown in markdown mode without raw fallback", () => {
    const content = [
      "Here is the plan:",
      "",
      "```ts",
      "const value = 1;",
    ].join("\n");
    const messages = [
      makeMessage("m1", 0, "user", "Show code example."),
      makeMessage("m2", 1, "assistant", content),
    ];
    const events = [
      makeEvent(0, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: content,
      }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const messageItems = result.items.filter(
      (item): item is Extract<ChatTimelineItem, { kind: "message" }> => item.kind === "message" && item.message.role === "assistant",
    );
    expect(messageItems).toHaveLength(1);
    expect(messageItems[0]?.renderHint).toBe("markdown");
    expect(messageItems[0]?.message.content).toBe(content);
  });

  it("does not split fenced markdown content into multiple assistant segments", () => {
    const content = [
      "Intro paragraph.",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "",
      "Closing paragraph.",
    ].join("\n");
    const messages = [
      makeMessage("m1", 0, "user", "Show code example."),
      makeMessage("m2", 1, "assistant", content),
    ];
    const events = [
      makeEvent(0, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: content,
      }),
      makeEvent(1, "chat.completed", { messageId: "m2" }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const messageItems = result.items.filter(
      (item): item is Extract<ChatTimelineItem, { kind: "message" }> => item.kind === "message" && item.message.role === "assistant",
    );
    expect(messageItems).toHaveLength(1);
    expect(messageItems[0]?.message.content).toBe(content);
    expect(messageItems[0]?.renderHint).toBe("markdown");
  });

  it("renders a single edited diff after manual edit approval and later worktree diff", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Update HomeActivity."),
      makeMessage("m2", 1, "assistant", "Selesai."),
    ];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Edit",
        toolUseId: "edit-1",
        editTarget: "/repo/app/src/HomeActivity.java",
      }),
      makeEvent(1, "permission.requested", {
        requestId: "perm-1",
        toolName: "Edit",
        blockedPath: "/repo/app/src/HomeActivity.java",
        toolInput: { file_path: "/repo/app/src/HomeActivity.java" },
      }),
      makeEvent(2, "permission.resolved", {
        requestId: "perm-1",
        decision: "allow",
      }),
      makeEvent(3, "tool.output", {
        toolName: "Edit",
        toolUseId: "edit-1",
      }),
      makeEvent(4, "tool.finished", {
        toolName: "Edit",
        summary: "Edited /repo/app/src/HomeActivity.java",
        precedingToolUseIds: ["edit-1"],
        editTarget: "/repo/app/src/HomeActivity.java",
        toolInput: { file_path: "/repo/app/src/HomeActivity.java" },
      }),
      makeEvent(5, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "Selesai.",
      }),
      makeEvent(6, "tool.finished", {
        source: "worktree.diff",
        changedFiles: ["app/src/HomeActivity.java"],
        diff: [
          "diff --git a/app/src/HomeActivity.java b/app/src/HomeActivity.java",
          "--- a/app/src/HomeActivity.java",
          "+++ b/app/src/HomeActivity.java",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
      }),
      makeEvent(7, "chat.completed", { messageId: "m2" }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const editedItems = result.items.filter(
      (item): item is Extract<ChatTimelineItem, { kind: "edited-diff" }> =>
        item.kind === "edited-diff" && item.changedFiles.some((file) => file.includes("HomeActivity.java")),
    );

    expect(editedItems).toHaveLength(1);
    expect(editedItems[0]).toMatchObject({
      kind: "edited-diff",
      diffKind: "actual",
      status: "success",
    });
    expect(editedItems[0]?.diff).toContain("+new");
  });

  it("renders one edited diff when a write target is only known after approval", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Create the file."),
      makeMessage("m2", 1, "assistant", "Created."),
    ];
    const absolutePath = "/Users/test/project/dogfood-output/edit-approval-smoke.txt";
    const relativePath = "dogfood-output/edit-approval-smoke.txt";
    const events = [
      makeEvent(0, "message.delta", {
        role: "user",
        messageId: "m1",
        delta: "Create the file.",
      }),
      makeEvent(1, "tool.started", {
        toolName: "write",
        toolUseId: "write-1",
        messageId: "m2",
      }),
      makeEvent(2, "permission.requested", {
        messageId: "m2",
        requestId: "perm-1",
        toolName: "write",
        blockedPath: relativePath,
        toolInput: {
          filepath: absolutePath,
          diff: [
            `Index: ${absolutePath}`,
            "===================================================================",
            `--- ${absolutePath}`,
            `+++ ${absolutePath}`,
            "@@ -0,0 +1,1 @@",
            "+EDIT_OK",
          ].join("\n"),
        },
      }),
      makeEvent(3, "permission.resolved", {
        requestId: "perm-1",
        decision: "allow",
      }),
      makeEvent(4, "tool.output", {
        toolName: "write",
        toolUseId: "write-1",
        messageId: "m2",
      }),
      makeEvent(5, "tool.finished", {
        toolName: "write",
        summary: relativePath,
        precedingToolUseIds: ["write-1"],
        toolInput: {
          content: "EDIT_OK",
          filePath: absolutePath,
        },
      }),
      makeEvent(6, "tool.finished", {
        source: "worktree.diff",
        summary: "Detected worktree changes in 1 file",
        changedFiles: [relativePath],
        diff: [
          `diff --git a/${relativePath} b/${relativePath}`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/${relativePath}`,
          "@@ -0,0 +1 @@",
          "+EDIT_OK",
        ].join("\n"),
      }),
      makeEvent(7, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "Created.",
      }),
      makeEvent(8, "chat.completed", { messageId: "m2" }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const editedItems = result.items.filter(
      (item): item is Extract<ChatTimelineItem, { kind: "edited-diff" }> =>
        item.kind === "edited-diff" && item.changedFiles.some((file) => file.includes("edit-approval-smoke.txt")),
    );

    expect(editedItems).toHaveLength(1);
    expect(editedItems[0]).toMatchObject({
      kind: "edited-diff",
      diffKind: "actual",
      status: "success",
    });
    expect(editedItems[0]?.diff).toContain("+EDIT_OK");
  });

  it("attaches resumed tool events to the new assistant turn when tool activity starts before text deltas", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Start the task."),
      makeMessage("m2", 1, "assistant", "Partial output before stop."),
      makeMessage("m3", 2, "user", "continue"),
      makeMessage("m4", 3, "assistant", ""),
    ];
    const events = [
      makeEvent(0, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "Partial output before stop.",
      }),
      makeEvent(1, "chat.completed", {
        messageId: "m2",
        cancelled: true,
      }),
      makeEvent(2, "message.delta", {
        role: "user",
        messageId: "m3",
        delta: "continue",
      }),
      makeEvent(3, "tool.started", {
        messageId: "m4",
        toolName: "Bash",
        toolUseId: "bash-2",
        command: "ls",
      }),
      makeEvent(4, "tool.finished", {
        messageId: "m4",
        toolName: "Bash",
        summary: "Ran ls",
        precedingToolUseIds: ["bash-2"],
      }),
      makeEvent(5, "chat.completed", {
        messageId: "m4",
      }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const resumedTool = result.items.find(
      (item): item is Extract<ChatTimelineItem, { kind: "tool" }> =>
        item.kind === "tool" && item.toolUseId === "bash-2",
    );

    expect(resumedTool).toBeTruthy();
    expect(resumedTool?.id.startsWith("m4:")).toBe(true);
    expect(resumedTool?.id.startsWith("m2:")).toBe(false);
  });

  it("keeps post-approval tool-only activity after a revealed plan card before the first execution delta", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Plan it."),
      makeMessage("m2", 1, "assistant", "Here is the implementation plan with extra context."),
      makeMessage("m3", 2, "assistant", ""),
    ];
    const events = [
      makeEvent(10, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "Plan context",
      }),
      makeEvent(11, "plan.created", {
        messageId: "m2",
        content: "1. Update the wording\n2. Tighten the spacing",
        filePath: ".claude/plans/codex-plan.md",
        source: "codex_plan_item",
      }),
      makeEvent(12, "chat.completed", { messageId: "m2", threadMode: "plan" }),
      makeEvent(13, "plan.approved", {
        filePath: ".claude/plans/codex-plan.md",
      }),
      makeEvent(14, "tool.started", {
        messageId: "m3",
        toolName: "Edit",
        toolUseId: "edit-1",
        editTarget: "/repo/src/app.ts",
      }),
      makeEvent(15, "tool.finished", {
        messageId: "m3",
        toolName: "Edit",
        summary: "Edited /repo/src/app.ts",
        precedingToolUseIds: ["edit-1"],
        editTarget: "/repo/src/app.ts",
        toolInput: { file_path: "/repo/src/app.ts" },
      }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const planIndex = result.items.findIndex((item) => item.kind === "plan-file-output");
    const editedIndex = result.items.findIndex((item) => item.kind === "edited-diff" && item.changedFiles.includes("/repo/src/app.ts"));

    expect(planIndex).toBeGreaterThan(-1);
    expect(editedIndex).toBeGreaterThan(-1);
    expect(planIndex).toBeLessThan(editedIndex);
  });

  it("treats Cursor .cursor plan files as canonical plan output", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Plan it."),
      makeMessage("m2", 1, "assistant", "Drafting the plan."),
    ];
    const events = [
      makeEvent(10, "plan.created", {
        messageId: "m2",
        content: "# Cursor Plan\n1. Inspect\n2. Report",
        filePath: "/Users/test/.cursor/plans/ship-cursor.plan.md",
        source: "streaming_fallback",
      }),
      makeEvent(11, "chat.completed", { messageId: "m2", threadMode: "plan" }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const planItem = result.items.find((item) => item.kind === "plan-file-output");
    expect(planItem).toMatchObject({
      kind: "plan-file-output",
      content: "# Cursor Plan\n1. Inspect\n2. Report",
      filePath: "/Users/test/.cursor/plans/ship-cursor.plan.md",
    });
  });
});
