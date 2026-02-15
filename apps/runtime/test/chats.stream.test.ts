import { describe, expect, it } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import { formatSseEvent, parseStreamStartCursor } from "../src/routes/chats";

describe("parseStreamStartCursor", () => {
  it("prefers the highest valid cursor between afterIdx and Last-Event-ID", () => {
    expect(parseStreamStartCursor("6", "9")).toBe(9);
    expect(parseStreamStartCursor("12", "4")).toBe(12);
  });

  it("ignores invalid cursor values", () => {
    expect(parseStreamStartCursor("nope", "7")).toBe(7);
    expect(parseStreamStartCursor("-1", "3")).toBe(3);
    expect(parseStreamStartCursor("2", "invalid")).toBe(2);
    expect(parseStreamStartCursor(undefined, undefined)).toBeUndefined();
  });
});

describe("formatSseEvent", () => {
  it("includes id, event type, and data payload", () => {
    const event: ChatEvent = {
      id: "evt-1",
      threadId: "thread-1",
      idx: 42,
      type: "message.delta",
      payload: {
        messageId: "msg-1",
        role: "assistant",
        delta: "hello",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const output = formatSseEvent(event);

    expect(output).toContain("id: 42\n");
    expect(output).toContain("event: message.delta\n");
    expect(output).toContain(`data: ${JSON.stringify(event)}\n\n`);
  });
});
