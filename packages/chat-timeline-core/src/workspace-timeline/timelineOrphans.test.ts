import { describe, expect, it } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import { processOrphanToolEvents } from "./timelineOrphans";

function makeEvent(
  idx: number,
  type: ChatEvent["type"],
  payload: Record<string, unknown>,
): ChatEvent {
  return {
    id: `e${idx}`,
    threadId: "t1",
    idx,
    type,
    payload,
    createdAt: new Date(1_700_000_000_000 + idx * 1_000).toISOString(),
  };
}

describe("processOrphanToolEvents", () => {
  it("prioritizes orphan edit runs before generic tool fallback", () => {
    const inlineToolEvents: ChatEvent[] = [
      makeEvent(1, "tool.started", {
        toolName: "Edit",
        toolUseId: "e1",
        toolInput: {
          file_path: "src/app.ts",
          old_string: "before",
          new_string: "after",
        },
      }),
      makeEvent(2, "tool.finished", {
        toolName: "Edit",
        summary: "Updated UI",
        precedingToolUseIds: ["e1"],
      }),
    ];

    const sortable: Array<{ item: { kind: string; [key: string]: unknown } }> = [];
    processOrphanToolEvents(
      inlineToolEvents,
      new Set<string>(),
      false,
      [],
      sortable as never,
      "t1",
      {
        streamingMessageIds: new Set<string>(),
        stickyRawFallbackMessageIds: new Set<string>(),
        renderDecisionByMessageId: new Map<string, string>(),
        loggedOrphanEventIdsByThread: new Map<string, Set<string>>(),
      },
    );

    const editedItems = sortable.filter((entry) => entry.item.kind === "edited-diff");
    const genericToolItems = sortable.filter((entry) => entry.item.kind === "tool");

    expect(editedItems).toHaveLength(1);
    expect(genericToolItems).toHaveLength(0);
    expect(editedItems[0]?.item.changedFiles).toEqual(["src/app.ts"]);
    expect(editedItems[0]?.item.diffKind).toBe("proposed");
  });

  it("coalesces AskUserQuestion with question request and answer events", () => {
    const inlineToolEvents: ChatEvent[] = [
      makeEvent(1, "tool.started", {
        toolName: "AskUserQuestion",
        toolUseId: "ask-1",
      }),
      makeEvent(2, "question.requested", {
        requestId: "ask-1",
        questions: [
          { question: "First question?" },
          { question: "Second question?" },
        ],
      }),
      makeEvent(3, "question.answered", {
        requestId: "ask-1",
        answers: {
          "First question?": "First answer",
          "Second question?": "Second answer",
        },
      }),
      makeEvent(4, "tool.finished", {
        toolName: "AskUserQuestion",
        summary: "Completed AskUserQuestion",
        precedingToolUseIds: ["ask-1"],
      }),
    ];

    const sortable: Array<{ item: { kind: string; [key: string]: unknown } }> = [];
    processOrphanToolEvents(
      inlineToolEvents,
      new Set<string>(),
      false,
      [],
      sortable as never,
      "t1",
      {
        streamingMessageIds: new Set<string>(),
        stickyRawFallbackMessageIds: new Set<string>(),
        renderDecisionByMessageId: new Map<string, string>(),
        loggedOrphanEventIdsByThread: new Map<string, Set<string>>(),
      },
    );

    const toolItems = sortable.filter((entry) => entry.item.kind === "tool");

    expect(toolItems).toHaveLength(1);
    expect(toolItems[0]?.item.toolName).toBe("AskUserQuestion");
    expect(toolItems[0]?.item.summary).toBe("Asked 2 Questions");
    expect((toolItems[0]?.item.sourceEvents as ChatEvent[] | undefined)?.map((event) => event.type)).toEqual([
      "tool.started",
      "question.requested",
      "question.answered",
      "tool.finished",
    ]);
  });
});
