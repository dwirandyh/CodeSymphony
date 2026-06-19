import { describe, expect, it } from "vitest";
import { shouldSkipChatThreadNavigationNotify } from "./chatNavigationNotify";

describe("shouldSkipChatThreadNavigationNotify", () => {
  it("does not skip when user intent is unset (URL/session drives navigation)", () => {
    expect(shouldSkipChatThreadNavigationNotify({ userIntentThreadId: undefined })).toBe(false);
  });

  it("skips while user intent is active including explicit null (no thread)", () => {
    expect(shouldSkipChatThreadNavigationNotify({ userIntentThreadId: "thread-a" })).toBe(true);
    expect(shouldSkipChatThreadNavigationNotify({ userIntentThreadId: null })).toBe(true);
  });
});