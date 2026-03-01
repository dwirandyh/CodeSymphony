import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@codesymphony/shared-types";
import { computeMessageAnchorIdxById } from "./useWorkspaceTimeline";

function makeMessage(id: string, seq: number, role: "assistant" | "user" = "assistant"): ChatMessage {
  return {
    id,
    threadId: "thread-1",
    seq,
    role,
    content: id,
    attachments: [],
    createdAt: "2026-03-01T00:00:00.000Z",
  };
}

describe("computeMessageAnchorIdxById", () => {
  it("infers anchors for messages whose early events were not loaded", () => {
    const messages = [
      makeMessage("m-0", 0, "user"),
      makeMessage("m-1", 1),
      makeMessage("m-2", 2),
    ];

    const firstMessageEventIdxById = new Map<string, number>([
      ["m-1", 125],
      ["m-2", 401],
    ]);

    const anchors = computeMessageAnchorIdxById(
      messages,
      firstMessageEventIdxById,
      new Map<string, number>(),
    );

    expect(anchors.get("m-0")).toBe(0);
    expect(anchors.get("m-1")).toBe(125);
    expect(anchors.get("m-2")).toBe(401);
  });

  it("interpolates anchors between known message anchors", () => {
    const messages = [
      makeMessage("m-1", 1),
      makeMessage("m-2", 2),
      makeMessage("m-3", 3),
      makeMessage("m-4", 4),
    ];

    const firstMessageEventIdxById = new Map<string, number>([
      ["m-1", 100],
      ["m-4", 103],
    ]);

    const anchors = computeMessageAnchorIdxById(
      messages,
      firstMessageEventIdxById,
      new Map<string, number>(),
    );

    expect(anchors.get("m-1")).toBe(100);
    expect(anchors.get("m-2")).toBe(101);
    expect(anchors.get("m-3")).toBe(102);
    expect(anchors.get("m-4")).toBe(103);
  });

  it("uses completed-message anchors when message.delta anchors are missing", () => {
    const messages = [
      makeMessage("m-1", 1),
      makeMessage("m-2", 2),
      makeMessage("m-3", 3),
    ];

    const completedEventIdxByMessageId = new Map<string, number>([
      ["m-2", 50],
    ]);

    const anchors = computeMessageAnchorIdxById(
      messages,
      new Map<string, number>(),
      completedEventIdxByMessageId,
    );

    expect(anchors.get("m-1")).toBe(49);
    expect(anchors.get("m-2")).toBe(50);
    expect(anchors.get("m-3")).toBe(51);
  });

  it("falls back to sequence when no anchors exist in events", () => {
    const messages = [
      makeMessage("m-7", 7),
      makeMessage("m-8", 8),
      makeMessage("m-9", 9),
    ];

    const anchors = computeMessageAnchorIdxById(
      messages,
      new Map<string, number>(),
      new Map<string, number>(),
    );

    expect(anchors.get("m-7")).toBe(7);
    expect(anchors.get("m-8")).toBe(8);
    expect(anchors.get("m-9")).toBe(9);
  });

});
