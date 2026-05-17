import { describe, expect, it } from "vitest";
import { shouldSuppressCompletionAttention } from "./useCompletionAttention";

describe("shouldSuppressCompletionAttention", () => {
  it("suppresses completion attention only for the visible focused thread", () => {
    expect(shouldSuppressCompletionAttention({
      appFocused: true,
      chatVisible: true,
      selectedThreadId: "thread-1",
      targetThreadId: "thread-1",
    })).toBe(true);

    expect(shouldSuppressCompletionAttention({
      appFocused: false,
      chatVisible: true,
      selectedThreadId: "thread-1",
      targetThreadId: "thread-1",
    })).toBe(false);

    expect(shouldSuppressCompletionAttention({
      appFocused: true,
      chatVisible: false,
      selectedThreadId: "thread-1",
      targetThreadId: "thread-1",
    })).toBe(false);

    expect(shouldSuppressCompletionAttention({
      appFocused: true,
      chatVisible: true,
      selectedThreadId: "thread-1",
      targetThreadId: "thread-2",
    })).toBe(false);
  });
});
