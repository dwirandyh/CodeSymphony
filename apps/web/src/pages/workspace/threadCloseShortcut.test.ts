import { describe, expect, it } from "vitest";
import { resolveMacCloseShortcutTarget } from "./threadCloseShortcut";

describe("resolveMacCloseShortcutTarget", () => {
  it("closes the active file tab when a file is open", () => {
    expect(
      resolveMacCloseShortcutTarget({
        activeView: "file",
        selectedThreadId: "thread-1",
        activeFilePath: "src/app.tsx",
        threadCount: 2,
        messageListEmptyState: "new-thread-empty",
      }),
    ).toBe("file");
  });

  it("closes the review tab when review is active", () => {
    expect(
      resolveMacCloseShortcutTarget({
        activeView: "review",
        selectedThreadId: "thread-1",
        activeFilePath: null,
        threadCount: 1,
        messageListEmptyState: null,
      }),
    ).toBe("review");
  });

  it("closes the automations panel when automations are active", () => {
    expect(
      resolveMacCloseShortcutTarget({
        activeView: "automations",
        selectedThreadId: "thread-1",
        activeFilePath: null,
        threadCount: 1,
        messageListEmptyState: null,
      }),
    ).toBe("automations");
  });

  it("closes the selected thread when multiple thread tabs exist", () => {
    expect(
      resolveMacCloseShortcutTarget({
        activeView: "chat",
        selectedThreadId: "thread-1",
        activeFilePath: null,
        threadCount: 2,
        messageListEmptyState: "new-thread-empty",
      }),
    ).toBe("thread");
  });

  it("allows native macOS behavior for the last empty thread", () => {
    expect(
      resolveMacCloseShortcutTarget({
        activeView: "chat",
        selectedThreadId: "thread-1",
        activeFilePath: null,
        threadCount: 1,
        messageListEmptyState: "existing-thread-empty",
      }),
    ).toBeNull();
  });

  it("closes the last thread when it already has content", () => {
    expect(
      resolveMacCloseShortcutTarget({
        activeView: "chat",
        selectedThreadId: "thread-1",
        activeFilePath: null,
        threadCount: 1,
        messageListEmptyState: null,
      }),
    ).toBe("thread");
  });

  it("does not intercept when no active tab can be closed", () => {
    expect(
      resolveMacCloseShortcutTarget({
        activeView: "file",
        selectedThreadId: null,
        activeFilePath: null,
        threadCount: 1,
        messageListEmptyState: null,
      }),
    ).toBeNull();
  });
});
