import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import { buildTimelineFromSeed } from "./timelineAssembler";

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
  messageId: string | null = null,
): ChatEvent {
  return {
    id: `e-${idx}`,
    threadId: "t1",
    messageId,
    idx,
    type,
    payload,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("buildTimelineFromSeed", () => {
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
      }, "m2"),
      makeEvent(5, "chat.completed", { messageId: "m2" }, "m2"),
    ];

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const askUserQuestionItem = result.items.find((item) => item.kind === "tool" && item.toolName === "AskUserQuestion");
    expect(askUserQuestionItem).toMatchObject({
      kind: "tool",
      toolName: "AskUserQuestion",
      summary: "Asked 3 Questions",
    });
    expect(askUserQuestionItem?.sourceEvents?.map((event) => event.type)).toEqual([
      "tool.started",
      "question.requested",
      "question.answered",
      "tool.finished",
    ]);
    expect(result.items.some((item) => item.kind === "activity")).toBe(false);
  });
});
