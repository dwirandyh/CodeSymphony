import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@codesymphony/shared-types";
import { applyMessageMutations } from "./messageEventMerge";
import type { PendingMessageMutation } from "./useChatSession.types";

function makeAssistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    threadId: "thread-1",
    seq: 1,
    role: "assistant",
    content: "",
    attachments: [],
    createdAt: "2026-02-28T00:00:00.000Z",
    ...overrides,
  };
}

function makeAssistantDelta(id: string, delta: string): PendingMessageMutation {
  return {
    kind: "message-delta",
    id,
    threadId: "thread-1",
    role: "assistant",
    delta,
  };
}

describe("applyMessageMutations", () => {
  it("keeps only the unseen suffix for cumulative deltas that arrive in the same batch", () => {
    const result = applyMessageMutations([], [
      makeAssistantDelta("m1", "Yang saya"),
      makeAssistantDelta("m1", "Yang saya kerjakan:"),
      makeAssistantDelta("m1", "Yang saya kerjakan:\n- tambah dependency"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("Yang saya kerjakan:\n- tambah dependency");
  });

  it("skips partial overlap when the next streamed delta starts with the existing tail", () => {
    const current = [
      makeAssistantMessage({
        content: "Yang saya ker",
      }),
    ];

    const result = applyMessageMutations(current, [
      makeAssistantDelta("m1", " kerjakan:"),
    ]);

    expect(result[0]?.content).toBe("Yang saya kerjakan:");
  });
});
