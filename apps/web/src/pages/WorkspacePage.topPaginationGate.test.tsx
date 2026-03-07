import { describe, expect, it } from "vitest";
import { resolveChatMessageListKey, shouldResetTopPaginationInteraction } from "./WorkspacePage";

describe("shouldResetTopPaginationInteraction", () => {
  it("returns false for temporary null churn", () => {
    expect(shouldResetTopPaginationInteraction("thread-a", null)).toBe(false);
    expect(shouldResetTopPaginationInteraction(null, "thread-a")).toBe(false);
    expect(shouldResetTopPaginationInteraction(null, null)).toBe(false);
  });

  it("returns false for same thread", () => {
    expect(shouldResetTopPaginationInteraction("thread-a", "thread-a")).toBe(false);
  });

  it("returns true for meaningful thread switches", () => {
    expect(shouldResetTopPaginationInteraction("thread-a", "thread-b")).toBe(true);
  });
});

describe("resolveChatMessageListKey", () => {
  it("keeps previous key during refresh bootstrap null churn", () => {
    expect(
      resolveChatMessageListKey({
        previousKey: "thread-a",
        previousThreadId: "thread-a",
        nextThreadId: null,
      }),
    ).toBe("thread-a");

    expect(
      resolveChatMessageListKey({
        previousKey: "thread-a",
        previousThreadId: null,
        nextThreadId: null,
      }),
    ).toBe("thread-a");
  });

  it("promotes empty key to selected thread", () => {
    expect(
      resolveChatMessageListKey({
        previousKey: "empty",
        previousThreadId: null,
        nextThreadId: "thread-a",
      }),
    ).toBe("thread-a");
  });

  it("updates key on meaningful thread switch", () => {
    expect(
      resolveChatMessageListKey({
        previousKey: "thread-a",
        previousThreadId: "thread-a",
        nextThreadId: "thread-b",
      }),
    ).toBe("thread-b");
  });

  it("keeps key stable for same-thread updates", () => {
    expect(
      resolveChatMessageListKey({
        previousKey: "thread-a",
        previousThreadId: "thread-a",
        nextThreadId: "thread-a",
      }),
    ).toBe("thread-a");
  });

  it("repairs a stale key when the selected thread differs", () => {
    expect(
      resolveChatMessageListKey({
        previousKey: "thread-a",
        previousThreadId: "thread-a",
        nextThreadId: "thread-b",
      }),
    ).toBe("thread-b");

    expect(
      resolveChatMessageListKey({
        previousKey: "thread-old",
        previousThreadId: null,
        nextThreadId: "thread-new",
      }),
    ).toBe("thread-new");
  });

  it("keeps key stable when the same thread reappears after temporary null churn", () => {
    const preservedKey = resolveChatMessageListKey({
      previousKey: "thread-a",
      previousThreadId: "thread-a",
      nextThreadId: null,
    });

    expect(preservedKey).toBe("thread-a");
    expect(
      resolveChatMessageListKey({
        previousKey: preservedKey,
        previousThreadId: null,
        nextThreadId: "thread-a",
      }),
    ).toBe("thread-a");
  });
});
