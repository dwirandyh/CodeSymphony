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
  it("suppresses raw bash cards for explore-like runs when the command only appears on tool.finished", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Find last updated in README."),
      makeMessage("m2", 1, "assistant", "**Results:**\n- found it"),
    ];
    const events = [
      makeEvent(0, "message.delta", {
        role: "assistant",
        messageId: "m1-assistant-intro",
        delta: "\n\n\n",
      }),
      makeEvent(1, "permission.requested", {
        toolName: "bash",
        requestId: "perm-1",
        command: 'rtk rg -n "last updated" README.md',
        messageId: "m2",
      }),
      makeEvent(2, "permission.resolved", {
        requestId: "perm-1",
        decision: "allow",
        messageId: "m2",
      }),
      makeEvent(3, "permission.requested", {
        toolName: "bash",
        requestId: "perm-2",
        command: "rtk sed -n '290,305p' README.md",
        messageId: "m2",
      }),
      makeEvent(4, "permission.resolved", {
        requestId: "perm-2",
        decision: "allow",
        messageId: "m2",
      }),
      makeEvent(5, "tool.started", {
        toolName: "Bash",
        toolUseId: "bash-rg",
        messageId: "m2",
      }),
      makeEvent(6, "tool.output", {
        toolName: "Bash",
        toolUseId: "bash-rg",
        messageId: "m2",
      }),
      makeEvent(7, "tool.started", {
        toolName: "Bash",
        toolUseId: "bash-sed",
        messageId: "m2",
      }),
      makeEvent(8, "tool.output", {
        toolName: "Bash",
        toolUseId: "bash-sed",
        messageId: "m2",
      }),
      makeEvent(9, "tool.finished", {
        toolName: "Bash",
        precedingToolUseIds: ["bash-rg"],
        command: 'rtk rg -n "last updated" README.md',
        summary: 'Search for "last updated" in README.md',
        messageId: "m2",
      }),
      makeEvent(10, "tool.finished", {
        toolName: "Bash",
        precedingToolUseIds: ["bash-sed"],
        command: "rtk sed -n '290,305p' README.md",
        summary: "Read lines 290-305 of README.md",
        messageId: "m2",
      }),
      makeEvent(11, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "**Results:**\n- found it",
      }),
      makeEvent(12, "chat.completed", {
        messageId: "m2",
      }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    expect(result.items.some((item) => item.kind === "tool" && item.toolName === "Bash")).toBe(false);

    const exploreItems = result.items.filter(
      (item): item is Extract<ChatTimelineItem, { kind: "explore-activity" }> => item.kind === "explore-activity",
    );
    expect(exploreItems).toHaveLength(1);
    expect(exploreItems[0]).toMatchObject({
      fileCount: 1,
      searchCount: 1,
      entries: [
        expect.objectContaining({
          kind: "search",
          label: 'Searched for "last updated" in README.md',
        }),
        expect.objectContaining({
          kind: "read",
          label: "lines 290-305 of README.md",
        }),
      ],
    });
  });

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

  it("keeps a completed explanatory message intact before a later AskUserQuestion card", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Plan this."),
      makeMessage(
        "m2",
        1,
        "assistant",
        "Intro satu. Intro dua. Pertanyaan pertama harus kunci kontrak link reset. Tanpa ini, kita tidak bisa memastikan route app. Repo sudah punya pattern kuat.",
      ),
    ];
    const events = [
      makeEvent(10, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "Intro satu. Intro dua. Pertanyaan pertama harus kunci kontrak link reset",
      }),
      makeEvent(20, "tool.started", {
        toolName: "Read",
        toolUseId: "read-1",
        messageId: "m2",
      }),
      makeEvent(21, "tool.finished", {
        toolName: "Read",
        summary: "Read brief.md",
        precedingToolUseIds: ["read-1"],
        messageId: "m2",
      }),
      makeEvent(30, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: ". Tanpa ini, kita tidak bisa memastikan route app.",
      }),
      makeEvent(40, "question.requested", {
        requestId: "ask-1",
        questions: [{ question: "Link shape?" }],
        messageId: "m2",
      }),
      makeEvent(41, "question.answered", {
        requestId: "ask-1",
        answers: { "Link shape?": "Universal Link" },
      }),
      makeEvent(60, "question.requested", {
        requestId: "ask-2",
        questions: [{ question: "Form rules?" }],
        messageId: "m2",
      }),
      makeEvent(61, "question.answered", {
        requestId: "ask-2",
        answers: { "Form rules?": "Mirror change password" },
      }),
      makeEvent(70, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: " Repo sudah punya pattern kuat.",
      }),
      makeEvent(71, "chat.completed", { messageId: "m2" }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const combinedMessageIndex = result.items.findIndex(
      (item) =>
        item.kind === "message"
        && item.message.content.includes("Pertanyaan pertama harus kunci kontrak link reset. Tanpa ini, kita tidak bisa memastikan route app."),
    );
    const splitTailIndex = result.items.findIndex(
      (item) =>
        item.kind === "message"
        && item.message.content.trim() === "Tanpa ini, kita tidak bisa memastikan route app.",
    );
    const firstQuestionIndex = result.items.findIndex(
      (item) => item.kind === "tool" && item.toolName === "AskUserQuestion",
    );

    expect(combinedMessageIndex).toBeGreaterThan(-1);
    expect(splitTailIndex).toBe(-1);
    expect(firstQuestionIndex).toBeGreaterThan(-1);
    expect(combinedMessageIndex).toBeLessThan(firstQuestionIndex);
  });

  it("interleaves AskUserQuestion cards with assistant text even when requestId differs from toolUseId", () => {
    const text1 = "Saya akan ground dulu ke repo dan cek pola nyata di feature/shopkeeper. ";
    const text2 = "Saya sudah verifikasi screen legacy dan caller dari home. ";
    const text3 = "Keputusan berikutnya menyentuh API publik core/ui. ";
    const messages = [
      makeMessage("m1", 0, "user", "rewrite"),
      makeMessage("m2", 1, "assistant", `${text1}${text2}${text3}`),
    ];
    const events = [
      makeEvent(1, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: text1,
      }),
      makeEvent(2, "tool.started", {
        toolName: "AskUserQuestion",
        toolUseId: "ask-call-1",
        messageId: "m2",
      }),
      makeEvent(3, "question.requested", {
        requestId: "question-1",
        questions: [{ question: "scope?" }],
        messageId: "m2",
      }),
      makeEvent(4, "question.answered", {
        requestId: "question-1",
        answers: { "scope?": "Android implementation" },
      }),
      makeEvent(5, "tool.finished", {
        toolName: "AskUserQuestion",
        precedingToolUseIds: ["ask-call-1"],
        summary: "Completed AskUserQuestion",
        messageId: "m2",
      }),
      makeEvent(6, "tool.started", {
        toolName: "AskUserQuestion",
        toolUseId: "ask-call-2",
        messageId: "m2",
      }),
      makeEvent(7, "question.requested", {
        requestId: "question-2",
        questions: [{ question: "button api?" }],
        messageId: "m2",
      }),
      makeEvent(8, "question.answered", {
        requestId: "question-2",
        answers: { "button api?": "variant enum" },
      }),
      makeEvent(9, "tool.finished", {
        toolName: "AskUserQuestion",
        precedingToolUseIds: ["ask-call-2"],
        summary: "Completed AskUserQuestion",
        messageId: "m2",
      }),
      makeEvent(10, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: text2,
      }),
      makeEvent(11, "tool.started", {
        toolName: "AskUserQuestion",
        toolUseId: "ask-call-3",
        messageId: "m2",
      }),
      makeEvent(12, "question.requested", {
        requestId: "question-3",
        questions: [{ question: "logout parity?" }],
        messageId: "m2",
      }),
      makeEvent(13, "question.answered", {
        requestId: "question-3",
        answers: { "logout parity?": "KickUnauthorized" },
      }),
      makeEvent(14, "tool.finished", {
        toolName: "AskUserQuestion",
        precedingToolUseIds: ["ask-call-3"],
        summary: "Completed AskUserQuestion",
        messageId: "m2",
      }),
      makeEvent(15, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: text3,
      }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const signatures = result.items.map((item) => (
      item.kind === "message"
        ? `message:${item.message.content}`
        : item.kind === "tool"
          ? `tool:${item.summary}`
          : item.kind
    ));

    expect(signatures).toEqual([
      "message:rewrite",
      `message:${text1}`,
      "tool:Asked 1 Question",
      "tool:Asked 1 Question",
      `message:${text2}`,
      "tool:Asked 1 Question",
      `message:${text3}`,
    ]);
  });

  it("preserves partial delta segmentation around bash cards when message content outruns the live deltas", () => {
    const text1 = "Saya stage hanya file task ini. ";
    const text2 = "Perubahan lain ";
    const text3 = "saya biarkan lokal. Commit sudah masuk. Push berikutnya aman.";
    const messages = [
      makeMessage("m1", 0, "user", "commit ini"),
      makeMessage("m2", 1, "assistant", `${text1}${text2}${text3}`),
    ];
    const events = [
      makeEvent(1, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: text1,
      }),
      makeEvent(2, "tool.started", {
        toolName: "Bash",
        toolUseId: "bash-add",
        messageId: "m2",
        command: "git add ...",
        shell: "bash",
        isBash: true,
      }),
      makeEvent(3, "tool.finished", {
        toolName: "Bash",
        precedingToolUseIds: ["bash-add"],
        messageId: "m2",
        summary: "Ran git add ...",
        command: "git add ...",
        shell: "bash",
        isBash: true,
      }),
      makeEvent(4, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: text2,
      }),
      makeEvent(5, "tool.started", {
        toolName: "Bash",
        toolUseId: "bash-commit",
        messageId: "m2",
        command: "git commit ...",
        shell: "bash",
        isBash: true,
      }),
      makeEvent(6, "tool.finished", {
        toolName: "Bash",
        precedingToolUseIds: ["bash-commit"],
        messageId: "m2",
        summary: "Ran git commit ...",
        command: "git commit ...",
        shell: "bash",
        isBash: true,
      }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const assistantMessages = result.items.filter(
      (item): item is Extract<(typeof result.items)[number], { kind: "message" }> =>
        item.kind === "message" && item.message.role === "assistant",
    );
    const firstToolIndex = result.items.findIndex(
      (item) => item.kind === "tool" && item.summary === "Ran git add ...",
    );
    const secondToolIndex = result.items.findIndex(
      (item) => item.kind === "tool" && item.summary === "Ran git commit ...",
    );
    const combinedMessageIndex = result.items.findIndex(
      (item) => item.kind === "message" && item.message.role === "assistant" && item.message.content === `${text1}${text2}${text3}`,
    );
    const firstAssistantIndex = result.items.findIndex(
      (item) => item.kind === "message" && item.message.role === "assistant" && item.message.content.startsWith(text1),
    );
    const trailingAssistantIndex = result.items.findIndex(
      (item) => item.kind === "message" && item.message.role === "assistant" && item.message.content.includes("Commit sudah masuk."),
    );

    expect(assistantMessages.length).toBeGreaterThanOrEqual(3);
    expect(firstAssistantIndex).toBeGreaterThan(-1);
    expect(firstToolIndex).toBeGreaterThan(firstAssistantIndex);
    expect(secondToolIndex).toBeGreaterThan(firstToolIndex);
    expect(trailingAssistantIndex).toBeGreaterThan(secondToolIndex);
    expect(combinedMessageIndex).toBe(-1);
  });

  it("keeps a completed explanatory message intact before a later explore activity card", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Investigate auth."),
      makeMessage(
        "m2",
        1,
        "assistant",
        "Intro satu. Intro dua. Fakta sementara: forgot password sudah ada. Yang belum kelihatan: form reset password. Sekarang saya cek reuse.",
      ),
    ];
    const events = [
      makeEvent(10, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "Intro satu. Intro dua. Fakta sementara: forgot password sudah ada",
      }),
      makeEvent(20, "tool.started", {
        toolName: "Read",
        toolUseId: "read-1",
        messageId: "m2",
      }),
      makeEvent(21, "tool.finished", {
        toolName: "Read",
        summary: "Read forgot_password_page.dart",
        precedingToolUseIds: ["read-1"],
        messageId: "m2",
      }),
      makeEvent(30, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: ". Yang belum kelihatan: form reset password.",
      }),
      makeEvent(40, "tool.started", {
        toolName: "Read",
        toolUseId: "read-2",
        messageId: "m2",
      }),
      makeEvent(41, "tool.finished", {
        toolName: "Read",
        summary: "Read change_password_page.dart",
        precedingToolUseIds: ["read-2"],
        messageId: "m2",
      }),
      makeEvent(60, "tool.started", {
        toolName: "Read",
        toolUseId: "read-3",
        messageId: "m2",
      }),
      makeEvent(61, "tool.finished", {
        toolName: "Read",
        summary: "Read main.dart",
        precedingToolUseIds: ["read-3"],
        messageId: "m2",
      }),
      makeEvent(70, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: " Sekarang saya cek reuse.",
      }),
      makeEvent(71, "chat.completed", { messageId: "m2" }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const combinedMessageIndex = result.items.findIndex(
      (item) =>
        item.kind === "message"
        && item.message.content.includes("Fakta sementara: forgot password sudah ada. Yang belum kelihatan: form reset password."),
    );
    const splitTailIndex = result.items.findIndex(
      (item) =>
        item.kind === "message"
        && item.message.content.trim() === "Yang belum kelihatan: form reset password.",
    );
    const secondExploreIndex = result.items.findIndex(
      (item) =>
        item.kind === "explore-activity"
        && item.entries.some((entry) => entry.label.includes("change_password_page.dart")),
    );

    expect(combinedMessageIndex).toBeGreaterThan(-1);
    expect(splitTailIndex).toBe(-1);
    expect(secondExploreIndex).toBeGreaterThan(-1);
    expect(combinedMessageIndex).toBeLessThan(secondExploreIndex);
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

  it("keeps a carried pre-edit announcement sentence ahead of the edit card", () => {
    const messages = [
      makeMessage("m1", 0, "user", "email To nya kok malah tidak terisi otomatis?"),
      makeMessage(
        "m2",
        1,
        "assistant",
        "Ah iya, maaf! Ada masalah dengan email To-nya. Mari saya perbaiki lagi:Sip sudah diperbaiki! ✅",
      ),
    ];
    const events = [
      makeEvent(1, "message.delta", { role: "assistant", messageId: "m2", delta: "Ah iya" }),
      makeEvent(2, "message.delta", { role: "assistant", messageId: "m2", delta: ", maaf!" }),
      makeEvent(3, "tool.started", {
        toolName: "Edit",
        toolUseId: "e1",
        toolInput: { file_path: "/repo/OTPLoginActivity.java", old_string: "a", new_string: "b" },
      }),
      makeEvent(4, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: " Ada masalah dengan email To-nya. Mari saya perbaiki lagi:",
      }),
      makeEvent(5, "tool.finished", {
        toolName: "Edit",
        summary: "Edited /repo/OTPLoginActivity.java",
        precedingToolUseIds: ["e1"],
        editTarget: "/repo/OTPLoginActivity.java",
      }),
      makeEvent(6, "message.delta", { role: "assistant", messageId: "m2", delta: "Sip sudah diperbaiki! ✅" }),
      makeEvent(7, "tool.finished", {
        source: "worktree.diff",
        changedFiles: ["/repo/OTPLoginActivity.java"],
        diff: [
          "diff --git a/OTPLoginActivity.java b/OTPLoginActivity.java",
          "--- a/OTPLoginActivity.java",
          "+++ b/OTPLoginActivity.java",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
      }),
      makeEvent(8, "chat.completed", { messageId: "m2" }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const issueIndex = result.items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Ada masalah dengan email To-nya."),
    );
    const announcementIndex = result.items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Mari saya perbaiki lagi:"),
    );
    const editIndex = result.items.findIndex(
      (item) => item.kind === "edited-diff" && item.changedFiles.some((file) => file.includes("OTPLoginActivity.java")),
    );
    const completionIndex = result.items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Sip sudah diperbaiki!"),
    );

    expect(issueIndex).toBeGreaterThan(-1);
    expect(announcementIndex).toBeGreaterThan(-1);
    expect(editIndex).toBeGreaterThan(-1);
    expect(completionIndex).toBeGreaterThan(-1);
    expect(issueIndex).toBeLessThan(announcementIndex);
    expect(announcementIndex).toBeLessThan(editIndex);
    expect(editIndex).toBeLessThan(completionIndex);
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

  it("keeps codex plans with inline-code question marks in the rendered plan card", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Plan it."),
      makeMessage("m2", 1, "assistant", "Drafting the plan."),
    ];
    const content = [
      "# Kotlin Plan",
      "",
      "1. Preserve nullable signatures like `Any?` during generation.",
      "2. Update the parser to keep those types stable.",
    ].join("\n");
    const events = [
      makeEvent(10, "plan.created", {
        messageId: "m2",
        content,
        filePath: "codex-plan-item",
        source: "codex_plan_item",
      }),
      makeEvent(11, "chat.completed", { messageId: "m2", threadMode: "plan" }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "plan-file-output",
          messageId: "m2",
          content,
          filePath: "codex-plan-item",
        }),
      ]),
    );
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

  it("treats OpenCode .opencode plan files as canonical plan output", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Plan it."),
      makeMessage("m2", 1, "assistant", "Drafting the plan."),
    ];
    const events = [
      makeEvent(10, "plan.created", {
        messageId: "m2",
        content: "# OpenCode Plan\n1. Inspect\n2. Report",
        filePath: "/Users/test/.opencode/plans/ship-opencode.plan.md",
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
      content: "# OpenCode Plan\n1. Inspect\n2. Report",
      filePath: "/Users/test/.opencode/plans/ship-opencode.plan.md",
    });
  });

  it("suppresses OpenCode clarification-shaped fallback plans even when they include numbered options", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Plan it."),
      makeMessage("m2", 1, "assistant", "Need clarification."),
    ];
    const events = [
      makeEvent(10, "plan.created", {
        messageId: "m2",
        content: [
          "Saya akan menganalisis codebase untuk memahami implementasi plan card dan membuat rencana perbaikan.",
          "",
          "Saya tidak menemukan implementasi \"OpenCode plan card\" di repo Flutter ini. Sebelum menyusun rencana, bisa jelaskan:",
          "",
          "**Apa yang dimaksud dengan \"OpenCode plan card\" di konteks ini?**",
          "",
          "1. Konfigurasi agent/prompt OpenCode di repo ini yang perlu diperbaiki?",
          "2. Fitur di dalam Flutter app yang menampilkan plan card dari AI?",
          "3. Atau sesuatu yang berbeda?",
        ].join("\n"),
        filePath: "/Users/test/.opencode/plans/ship-opencode.plan.md",
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

    expect(result.items.some((item) => item.kind === "plan-file-output")).toBe(false);
  });

  it("suppresses raw handoff plan seed text when the plan card is the only semantic output", () => {
    const planContent = "# Plan\n\n1. Implement the feature";
    const messages = [
      makeMessage("m1", 0, "user", "Please execute the approved plan."),
      makeMessage("m2", 1, "assistant", planContent),
    ];
    const events = [
      makeEvent(10, "plan.created", {
        messageId: "m2",
        content: planContent,
        filePath: ".claude/plans/plan.md",
        source: "claude_plan_file",
      }),
      makeEvent(11, "plan.approved", {
        messageId: "m2",
        filePath: ".claude/plans/plan.md",
      }),
      makeEvent(12, "tool.started", {
        messageId: "m2",
        toolName: "ExitPlanMode",
        toolUseId: "exit-plan-1",
      }),
      makeEvent(13, "tool.finished", {
        messageId: "m2",
        toolName: "ExitPlanMode",
        toolUseId: "exit-plan-1",
        precedingToolUseIds: ["exit-plan-1"],
      }),
      makeEvent(14, "chat.completed", { messageId: "m3", threadMode: "default" }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    expect(result.items.some((item) =>
      item.kind === "message"
      && item.message.id === "m2",
    )).toBe(false);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "plan-file-output",
          messageId: "m2",
          content: planContent,
          filePath: ".claude/plans/plan.md",
        }),
      ]),
    );
  });

  it("renders coalesced skill cards before assistant text when skill events happen first", () => {
    const messages = [
      makeMessage("m1", 0, "user", "hi, what is today?"),
      makeMessage("m2", 1, "assistant", "Today: 2026-05-10."),
    ];
    const events = [
      makeEvent(1, "tool.started", {
        messageId: "m2",
        toolName: "Skill",
        toolUseId: "call-skill-1",
        skillName: "caveman",
      }),
      makeEvent(2, "tool.finished", {
        messageId: "m2",
        toolName: "Skill",
        precedingToolUseIds: ["call-skill-1"],
        skillName: "caveman",
        summary: "Completed Skill",
      }),
      makeEvent(3, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "Today: 2026-05-10.",
      }),
      makeEvent(4, "chat.completed", {
        messageId: "m2",
      }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const skillItemIndex = result.items.findIndex((item) =>
      item.kind === "tool" && item.toolName === "Skill" && item.toolUseId === "call-skill-1",
    );
    const assistantItemIndex = result.items.findIndex((item) =>
      item.kind === "message" && item.message.id === "m2",
    );

    expect(skillItemIndex).toBeGreaterThanOrEqual(0);
    expect(assistantItemIndex).toBeGreaterThanOrEqual(0);
    expect(skillItemIndex).toBeLessThan(assistantItemIndex);
  });

  it("infers Cursor terminal commands from assistant markdown when raw tool input is missing", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Run commands."),
      makeMessage(
        "m2",
        1,
        "assistant",
        [
          "Running those commands now.",
          "",
          "**`pwd`:** `/repo`",
          "",
          "**`echo hello-after-fix`:** `hello-after-fix`",
        ].join("\n"),
      ),
    ];
    const events = [
      makeEvent(0, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "Running those commands now.\n\n",
      }),
      makeEvent(1, "tool.started", {
        messageId: "m2",
        toolName: "Bash",
        toolUseId: "bash-1",
        shell: "bash",
        isBash: true,
      }),
      makeEvent(2, "tool.output", {
        messageId: "m2",
        toolName: "Bash",
        toolUseId: "bash-1",
      }),
      makeEvent(3, "tool.finished", {
        messageId: "m2",
        toolName: "Bash",
        precedingToolUseIds: ["bash-1"],
        summary: "Ran terminal command",
        output: "/repo\nhello-after-fix\n",
        shell: "bash",
        isBash: true,
      }),
      makeEvent(4, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "**`pwd`:** `/repo`\n\n**`echo hello-after-fix`:** `hello-after-fix`",
      }),
      makeEvent(5, "chat.completed", {
        messageId: "m2",
      }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const toolItem = result.items.find(
      (item): item is Extract<ChatTimelineItem, { kind: "tool" }> =>
        item.kind === "tool" && item.toolName === "Bash",
    );

    expect(toolItem).toMatchObject({
      kind: "tool",
      toolName: "Bash",
      command: "pwd && echo hello-after-fix",
      summary: "Ran terminal command",
      output: "/repo\nhello-after-fix\n",
    });
  });

  it("renders one persistent todo-list plus started todo progress events", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Implement todo timeline."),
      makeMessage("m2", 1, "assistant", "Still working."),
    ];
    const events = [
      makeEvent(0, "todo.updated", {
        agent: "codex",
        groupId: "turn-1",
        explanation: "Implement todo timeline",
        items: [
          { id: "1", content: "Inspect current timeline", status: "in_progress" },
          { id: "2", content: "Render todo row", status: "pending" },
        ],
        messageId: "m2",
      }),
      makeEvent(1, "todo.updated", {
        agent: "codex",
        groupId: "turn-1",
        explanation: "Implement todo timeline",
        items: [
          { id: "1", content: "Inspect current timeline", status: "completed" },
          { id: "2", content: "Render todo row", status: "in_progress" },
        ],
        messageId: "m2",
      }),
      makeEvent(2, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "Still working.",
      }),
      makeEvent(3, "chat.completed", {
        messageId: "m2",
      }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const todoItems = result.items.filter(
      (item): item is Extract<ChatTimelineItem, { kind: "todo-list" }> => item.kind === "todo-list",
    );
    const todoProgressItems = result.items.filter(
      (item): item is Extract<ChatTimelineItem, { kind: "todo-progress" }> => item.kind === "todo-progress",
    );

    expect(todoItems).toHaveLength(1);
    expect(todoItems[0]).toMatchObject({
      kind: "todo-list",
      agent: "codex",
      groupId: "turn-1",
      explanation: "Implement todo timeline",
      status: "running",
      items: [
        { id: "1", content: "Inspect current timeline", status: "completed" },
        { id: "2", content: "Render todo row", status: "in_progress" },
      ],
    });
    expect(todoProgressItems).toHaveLength(2);
    expect(todoProgressItems[0]).toMatchObject({
      kind: "todo-progress",
      agent: "codex",
      groupId: "turn-1",
      content: "Inspect current timeline",
    });
    expect(todoProgressItems[1]).toMatchObject({
      kind: "todo-progress",
      agent: "codex",
      groupId: "turn-1",
      content: "Render todo row",
    });
  });

  it("collapses recreated todo-lists across turns into one persistent row", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Prepare the work."),
      makeMessage("m2", 1, "assistant", "Saya siapkan daftar tugas."),
      makeMessage("m3", 2, "user", "Lanjutkan."),
      makeMessage("m4", 3, "assistant", "Saya mulai kerjakan."),
    ];
    const events = [
      makeEvent(0, "todo.updated", {
        agent: "codex",
        groupId: "turn-1",
        items: [
          { id: "1", content: "Inspect current timeline", status: "pending" },
          { id: "2", content: "Render todo row", status: "pending" },
        ],
        messageId: "m2",
      }),
      makeEvent(1, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "Saya siapkan daftar tugas.",
      }),
      makeEvent(2, "todo.updated", {
        agent: "codex",
        groupId: "turn-2",
        items: [
          { id: "1", content: "Inspect current timeline", status: "in_progress" },
          { id: "2", content: "Render todo row", status: "pending" },
        ],
        messageId: "m4",
      }),
      makeEvent(3, "tool.started", {
        toolName: "Bash",
        toolUseId: "bash-1",
        messageId: "m4",
      }),
      makeEvent(4, "tool.finished", {
        toolName: "Bash",
        precedingToolUseIds: ["bash-1"],
        summary: "Ran git status --short",
        command: "git status --short",
        messageId: "m4",
      }),
      makeEvent(5, "message.delta", {
        role: "assistant",
        messageId: "m4",
        delta: "Saya mulai kerjakan.",
      }),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const todoItems = result.items.filter(
      (item): item is Extract<ChatTimelineItem, { kind: "todo-list" }> => item.kind === "todo-list",
    );
    const todoProgressItems = result.items.filter(
      (item): item is Extract<ChatTimelineItem, { kind: "todo-progress" }> => item.kind === "todo-progress",
    );
    const bashItemIndex = result.items.findIndex((item) => item.kind === "tool" && item.toolName === "Bash");
    const todoProgressIndex = result.items.findIndex((item) => item.kind === "todo-progress");

    expect(todoItems).toHaveLength(1);
    expect(todoItems[0]).toMatchObject({
      kind: "todo-list",
      messageId: "m2",
      agent: "codex",
      status: "running",
      items: [
        { id: "1", content: "Inspect current timeline", status: "in_progress" },
        { id: "2", content: "Render todo row", status: "pending" },
      ],
    });
    expect(todoProgressItems).toHaveLength(1);
    expect(todoProgressItems[0]).toMatchObject({
      kind: "todo-progress",
      messageId: "m4",
      agent: "codex",
      content: "Inspect current timeline",
    });
    expect(todoProgressIndex).toBeGreaterThan(-1);
    expect(bashItemIndex).toBeGreaterThan(todoProgressIndex);
  });
});
