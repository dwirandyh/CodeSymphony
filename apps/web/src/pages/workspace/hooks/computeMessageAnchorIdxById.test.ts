import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@codesymphony/shared-types";
import { computeMessageAnchorIdxById } from "./useWorkspaceTimeline";

function makeMessage(id: string, seq: number): ChatMessage {
  return {
    id,
    threadId: "t1",
    seq,
    role: "assistant",
    content: id,
    attachments: [],
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("computeMessageAnchorIdxById", () => {
  it("returns empty map for no messages", () => {
    const result = computeMessageAnchorIdxById([], new Map(), new Map());
    expect(result.size).toBe(0);
  });

  it("uses firstMessageEventIdxById when available", () => {
    const messages = [makeMessage("m1", 1), makeMessage("m2", 2)];
    const firstEvents = new Map([["m1", 10], ["m2", 20]]);
    const result = computeMessageAnchorIdxById(messages, firstEvents, new Map());
    expect(result.get("m1")).toBe(10);
    expect(result.get("m2")).toBe(20);
  });

  it("uses completedEventIdxByMessageId as fallback", () => {
    const messages = [makeMessage("m1", 1)];
    const completed = new Map([["m1", 50]]);
    const result = computeMessageAnchorIdxById(messages, new Map(), completed);
    expect(result.get("m1")).toBe(50);
  });

  it("falls back to seq for all messages when no anchors", () => {
    const messages = [makeMessage("m1", 1), makeMessage("m2", 2), makeMessage("m3", 3)];
    const result = computeMessageAnchorIdxById(messages, new Map(), new Map());
    expect(result.get("m1")).toBe(1);
    expect(result.get("m2")).toBe(2);
    expect(result.get("m3")).toBe(3);
  });

  it("interpolates between known anchors", () => {
    const messages = [
      makeMessage("m1", 1),
      makeMessage("m2", 2),
      makeMessage("m3", 3),
    ];
    const firstEvents = new Map([["m1", 10], ["m3", 30]]);
    const result = computeMessageAnchorIdxById(messages, firstEvents, new Map());
    expect(result.get("m1")).toBe(10);
    expect(result.get("m3")).toBe(30);
    const m2Anchor = result.get("m2")!;
    expect(m2Anchor).toBeGreaterThan(10);
    expect(m2Anchor).toBeLessThan(30);
  });

  it("projects anchors for trailing messages after last known anchor", () => {
    const messages = [
      makeMessage("m1", 1),
      makeMessage("m2", 2),
      makeMessage("m3", 3),
    ];
    const firstEvents = new Map([["m1", 10]]);
    const result = computeMessageAnchorIdxById(messages, firstEvents, new Map());
    expect(result.get("m1")).toBe(10);
    const m2Anchor = result.get("m2")!;
    const m3Anchor = result.get("m3")!;
    expect(m2Anchor).toBeGreaterThan(10);
    expect(m3Anchor).toBeGreaterThan(m2Anchor);
  });

  it("projects anchors for leading messages before first known anchor", () => {
    const messages = [
      makeMessage("m1", 1),
      makeMessage("m2", 2),
      makeMessage("m3", 3),
    ];
    const firstEvents = new Map([["m3", 30]]);
    const result = computeMessageAnchorIdxById(messages, firstEvents, new Map());
    expect(result.get("m3")).toBe(30);
    expect(result.has("m1")).toBe(true);
    expect(result.has("m2")).toBe(true);
  });

  it("handles single message with anchor", () => {
    const messages = [makeMessage("m1", 5)];
    const firstEvents = new Map([["m1", 100]]);
    const result = computeMessageAnchorIdxById(messages, firstEvents, new Map());
    expect(result.get("m1")).toBe(100);
  });
});
