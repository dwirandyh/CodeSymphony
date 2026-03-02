import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatAttachment } from "@codesymphony/shared-types";
import {
  areMessagesEqual,
  areMessageArraysEqual,
  mergeThreadMessages,
} from "./messageMerge";

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    threadId: "t1",
    seq: 1,
    role: "user",
    content: "hello",
    attachments: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeAttachment(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    id: "a1",
    messageId: "m1",
    filename: "file.txt",
    mimeType: "text/plain",
    sizeBytes: 100,
    source: "upload",
    storagePath: "/uploads/file.txt",
    content: "file content",
    ...overrides,
  };
}

describe("areMessagesEqual", () => {
  it("returns true for identical messages", () => {
    const m = makeMessage();
    expect(areMessagesEqual(m, { ...m })).toBe(true);
  });

  it("returns false for different id", () => {
    expect(areMessagesEqual(makeMessage({ id: "m1" }), makeMessage({ id: "m2" }))).toBe(false);
  });

  it("returns false for different content", () => {
    expect(areMessagesEqual(
      makeMessage({ content: "a" }),
      makeMessage({ content: "b" }),
    )).toBe(false);
  });

  it("returns false for different role", () => {
    expect(areMessagesEqual(
      makeMessage({ role: "user" }),
      makeMessage({ role: "assistant" }),
    )).toBe(false);
  });

  it("returns false for different seq", () => {
    expect(areMessagesEqual(
      makeMessage({ seq: 1 }),
      makeMessage({ seq: 2 }),
    )).toBe(false);
  });

  it("returns true when both have empty attachments", () => {
    expect(areMessagesEqual(
      makeMessage({ attachments: [] }),
      makeMessage({ attachments: [] }),
    )).toBe(true);
  });

  it("returns false when attachment counts differ", () => {
    expect(areMessagesEqual(
      makeMessage({ attachments: [makeAttachment()] }),
      makeMessage({ attachments: [] }),
    )).toBe(false);
  });

  it("returns false when attachment content differs", () => {
    expect(areMessagesEqual(
      makeMessage({ attachments: [makeAttachment({ content: "a" })] }),
      makeMessage({ attachments: [makeAttachment({ content: "b" })] }),
    )).toBe(false);
  });

  it("returns false when attachment filename differs", () => {
    expect(areMessagesEqual(
      makeMessage({ attachments: [makeAttachment({ filename: "a.txt" })] }),
      makeMessage({ attachments: [makeAttachment({ filename: "b.txt" })] }),
    )).toBe(false);
  });
});

describe("areMessageArraysEqual", () => {
  it("returns true for empty arrays", () => {
    expect(areMessageArraysEqual([], [])).toBe(true);
  });

  it("returns true for identical arrays", () => {
    const arr = [makeMessage({ id: "m1" }), makeMessage({ id: "m2", seq: 2 })];
    expect(areMessageArraysEqual(arr, [...arr])).toBe(true);
  });

  it("returns false for different lengths", () => {
    expect(areMessageArraysEqual([makeMessage()], [])).toBe(false);
  });

  it("returns false for different messages at same index", () => {
    expect(areMessageArraysEqual(
      [makeMessage({ content: "a" })],
      [makeMessage({ content: "b" })],
    )).toBe(false);
  });
});

describe("mergeThreadMessages", () => {
  it("returns queried messages when no local", () => {
    const queried = [makeMessage({ id: "m1", seq: 1 })];
    const result = mergeThreadMessages(queried, []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  it("returns local messages when no queried", () => {
    const local = [makeMessage({ id: "m1", seq: 1, content: "local" })];
    const result = mergeThreadMessages([], local);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("local");
  });

  it("merges local-only messages into result", () => {
    const queried = [makeMessage({ id: "m1", seq: 1 })];
    const local = [makeMessage({ id: "m2", seq: 2, content: "local" })];
    const result = mergeThreadMessages(queried, local);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("m1");
    expect(result[1].id).toBe("m2");
  });

  it("prefers local message when it has longer content", () => {
    const queried = [makeMessage({ id: "m1", content: "short" })];
    const local = [makeMessage({ id: "m1", content: "longer content here" })];
    const result = mergeThreadMessages(queried, local);
    expect(result[0].content).toBe("longer content here");
  });

  it("keeps queried message when local has shorter content", () => {
    const queried = [makeMessage({ id: "m1", content: "longer queried content" })];
    const local = [makeMessage({ id: "m1", content: "short" })];
    const result = mergeThreadMessages(queried, local);
    expect(result[0].content).toBe("longer queried content");
  });

  it("sorts merged messages by seq", () => {
    const queried = [makeMessage({ id: "m3", seq: 3 })];
    const local = [makeMessage({ id: "m1", seq: 1 }), makeMessage({ id: "m2", seq: 2 })];
    const result = mergeThreadMessages(queried, local);
    expect(result.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });
});
