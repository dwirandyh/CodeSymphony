import { describe, expect, it } from "vitest";
import type { ChatThread } from "@codesymphony/shared-types";
import {
  buildSessionShortcutCycleHistory,
  buildSessionShortcutTargets,
  getActiveSessionShortcutTarget,
  normalizeSessionShortcutHistory,
  promoteSessionShortcutTarget,
} from "./sessionShortcutTargets";

const thread = (id: string): ChatThread => ({
  id,
  worktreeId: "worktree-1",
  title: id,
  kind: "default",
  permissionProfile: "default",
  permissionMode: "default",
  mode: "default",
  titleEditedManually: false,
  claudeSessionId: null,
  active: false,
  createdAt: "2026-05-27T00:00:00.000Z",
  updatedAt: "2026-05-27T00:00:00.000Z",
});

describe("sessionShortcutTargets", () => {
  it("builds session targets in visible tab order", () => {
    expect(
      buildSessionShortcutTargets({
        threads: [thread("thread-1"), thread("thread-2")],
        terminalTabs: [{ id: "terminal-1", title: "Terminal", sessionId: "session-1" }],
        reviewTabOpen: true,
        fileTabs: [{ path: "src/app.tsx" }],
      }),
    ).toEqual([
      { kind: "thread", id: "thread-1" },
      { kind: "thread", id: "thread-2" },
      { kind: "terminal", id: "terminal-1" },
      { kind: "review" },
      { kind: "file", path: "src/app.tsx" },
    ]);
  });

  it("resolves the active terminal before chat thread when terminal view is visible", () => {
    const targets = buildSessionShortcutTargets({
      threads: [thread("thread-1")],
      terminalTabs: [{ id: "terminal-1", title: "Terminal", sessionId: "session-1" }],
      reviewTabOpen: false,
      fileTabs: [],
    });

    expect(
      getActiveSessionShortcutTarget(targets, {
        activeView: "chat",
        selectedThreadId: "thread-1",
        terminalViewActive: true,
        activeTerminalTabId: "terminal-1",
        activeFilePath: null,
      }),
    ).toEqual({ kind: "terminal", id: "terminal-1" });
  });

  it("keeps MRU history deduped and limited to open session targets", () => {
    const targets = buildSessionShortcutTargets({
      threads: [thread("thread-1"), thread("thread-2")],
      terminalTabs: [{ id: "terminal-1", title: "Terminal", sessionId: "session-1" }],
      reviewTabOpen: false,
      fileTabs: [],
    });

    const history = promoteSessionShortcutTarget(
      [
        { kind: "thread", id: "thread-1" },
        { kind: "thread", id: "deleted-thread" },
        { kind: "terminal", id: "terminal-1" },
        { kind: "thread", id: "thread-1" },
      ],
      { kind: "thread", id: "thread-2" },
      targets,
    );

    expect(history).toEqual([
      { kind: "thread", id: "thread-2" },
      { kind: "thread", id: "thread-1" },
      { kind: "terminal", id: "terminal-1" },
    ]);
    expect(normalizeSessionShortcutHistory(history, targets)).toEqual(history);
  });

  it("seeds Ctrl+Tab cycling from visible order when MRU history is sparse", () => {
    const targets = buildSessionShortcutTargets({
      threads: [thread("thread-1"), thread("thread-2")],
      terminalTabs: [{ id: "terminal-1", title: "Terminal", sessionId: "session-1" }],
      reviewTabOpen: false,
      fileTabs: [],
    });

    expect(
      buildSessionShortcutCycleHistory([], targets, { kind: "thread", id: "thread-1" }),
    ).toEqual([
      { kind: "thread", id: "thread-1" },
      { kind: "thread", id: "thread-2" },
      { kind: "terminal", id: "terminal-1" },
    ]);
  });
});
