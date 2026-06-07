import { beforeEach, describe, expect, it } from "vitest";
import {
  getBottomPanelState,
  readPersistedWorkspaceTerminalUiState,
  reconcileWorkspaceTerminalTabs,
  restoreWorkspaceTerminalUiState,
  WORKSPACE_TERMINAL_UI_STORAGE_KEY,
  writePersistedWorkspaceTerminalUiState,
} from "./workspaceTerminalPersistence";

const serverTab = (overrides: Partial<{ id: string; worktreeId: string; sessionId: string; title: string; ordinal: number }> = {}) => ({
  id: overrides.id ?? "tab-1",
  worktreeId: overrides.worktreeId ?? "wt1",
  sessionId: overrides.sessionId ?? "wt1:terminal:tab-1",
  title: overrides.title ?? "Terminal",
  ordinal: overrides.ordinal ?? 1,
});

describe("reconcileWorkspaceTerminalTabs", () => {
  it("adds tabs created by another client", () => {
    const next = reconcileWorkspaceTerminalTabs({
      current: { tabs: [], activeTabId: null, visible: false, nextOrdinal: 1 },
      serverTabs: [serverTab({ id: "a", sessionId: "wt1:terminal:a", title: "Terminal", ordinal: 1 })],
    });

    expect(next.tabs).toEqual([{ id: "a", sessionId: "wt1:terminal:a", title: "Terminal" }]);
    expect(next.nextOrdinal).toBe(2);
  });

  it("removes tabs closed by another client and reselects the active tab", () => {
    const next = reconcileWorkspaceTerminalTabs({
      current: {
        tabs: [
          { id: "a", sessionId: "wt1:terminal:a", title: "Terminal" },
          { id: "b", sessionId: "wt1:terminal:b", title: "Terminal 2" },
        ],
        activeTabId: "b",
        visible: true,
        nextOrdinal: 3,
      },
      serverTabs: [serverTab({ id: "a", sessionId: "wt1:terminal:a", title: "Terminal", ordinal: 1 })],
    });

    expect(next.tabs).toEqual([{ id: "a", sessionId: "wt1:terminal:a", title: "Terminal" }]);
    expect(next.activeTabId).toBe("a");
  });

  it("keeps the active tab when it still exists and orders tabs by server ordinal", () => {
    const next = reconcileWorkspaceTerminalTabs({
      current: {
        tabs: [{ id: "a", sessionId: "wt1:terminal:a", title: "Terminal" }],
        activeTabId: "a",
        visible: true,
        nextOrdinal: 2,
      },
      serverTabs: [
        serverTab({ id: "b", sessionId: "wt1:terminal:b", title: "Terminal 2", ordinal: 2 }),
        serverTab({ id: "a", sessionId: "wt1:terminal:a", title: "Terminal", ordinal: 1 }),
      ],
    });

    expect(next.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(next.activeTabId).toBe("a");
    expect(next.nextOrdinal).toBe(3);
  });

  it("clears active tab and hides view when the server has no tabs", () => {
    const next = reconcileWorkspaceTerminalTabs({
      current: {
        tabs: [{ id: "a", sessionId: "wt1:terminal:a", title: "Terminal" }],
        activeTabId: "a",
        visible: true,
        nextOrdinal: 2,
      },
      serverTabs: [],
    });

    expect(next.tabs).toEqual([]);
    expect(next.activeTabId).toBeNull();
    expect(next.visible).toBe(false);
  });

  it("returns the same reference when nothing changed to avoid re-renders", () => {
    const current = {
      tabs: [{ id: "a", sessionId: "wt1:terminal:a", title: "Terminal" }],
      activeTabId: "a",
      visible: true,
      nextOrdinal: 2,
    };
    const next = reconcileWorkspaceTerminalTabs({
      current,
      serverTabs: [serverTab({ id: "a", sessionId: "wt1:terminal:a", title: "Terminal", ordinal: 1 })],
    });

    expect(next).toBe(current);
  });
});

describe("workspaceTerminalPersistence", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("restores terminal tabs and run sessions for the same runtime without reopening the bottom panel", () => {
    writePersistedWorkspaceTerminalUiState(sessionStorage, {
      runtimePid: 321,
      bottomPanelStateByWorktreeId: {
        wt1: {
          activeTab: "run",
          openSignal: 3,
          runScriptActive: true,
          runScriptSessionId: "wt1:script-runner:1",
          collapsed: false,
        },
      },
      terminalTabsByWorktreeId: {
        wt1: {
          tabs: [
            { id: "tab-1", title: "Terminal", sessionId: "wt1:terminal:1" },
            { id: "tab-2", title: "Terminal 2", sessionId: "wt1:terminal:missing" },
          ],
          activeTabId: "tab-2",
          visible: true,
          nextOrdinal: 4,
        },
      },
    });

    const persistedState = readPersistedWorkspaceTerminalUiState(sessionStorage);
    const restoredState = restoreWorkspaceTerminalUiState({
      persistedState,
      runtimePid: 321,
      terminalSessions: [
        {
          sessionId: "wt1:terminal:1",
          requestedCwd: "/tmp/wt1",
          resolvedCwd: "/tmp/wt1",
          active: true,
          exitCode: null,
          signal: null,
        },
        {
          sessionId: "wt1:script-runner:1",
          requestedCwd: "/tmp/wt1",
          resolvedCwd: "/tmp/wt1",
          active: false,
          exitCode: 0,
          signal: 0,
        },
      ],
    });

    expect(restoredState).toEqual({
      bottomPanelStateByWorktreeId: {
        wt1: {
          activeTab: "run",
          openSignal: 0,
          runScriptActive: false,
          runScriptSessionId: "wt1:script-runner:1",
          collapsed: true,
        },
      },
      terminalTabsByWorktreeId: {
        wt1: {
          tabs: [
            { id: "tab-1", title: "Terminal", sessionId: "wt1:terminal:1" },
          ],
          activeTabId: "tab-1",
          visible: true,
          nextOrdinal: 4,
        },
      },
    });
  });

  it("ignores persisted state from another runtime", () => {
    writePersistedWorkspaceTerminalUiState(sessionStorage, {
      runtimePid: 111,
      bottomPanelStateByWorktreeId: {},
      terminalTabsByWorktreeId: {},
    });

    const persistedState = readPersistedWorkspaceTerminalUiState(sessionStorage);
    const restoredState = restoreWorkspaceTerminalUiState({
      persistedState,
      runtimePid: 222,
      terminalSessions: [],
    });

    expect(restoredState).toBeNull();
  });

  it("falls back to the default bottom tab when the run session no longer exists", () => {
    sessionStorage.setItem(WORKSPACE_TERMINAL_UI_STORAGE_KEY, JSON.stringify({
      version: 1,
      runtimePid: 123,
      bottomPanelStateByWorktreeId: {
        wt1: {
          activeTab: "run",
          openSignal: 1,
          runScriptActive: true,
          runScriptSessionId: "wt1:script-runner:missing",
          collapsed: false,
        },
      },
      terminalTabsByWorktreeId: {},
    }));

    const persistedState = readPersistedWorkspaceTerminalUiState(sessionStorage);
    const restoredState = restoreWorkspaceTerminalUiState({
      persistedState,
      runtimePid: 123,
      terminalSessions: [],
    });

    expect(restoredState).toEqual({
      bottomPanelStateByWorktreeId: {
        wt1: {
          activeTab: "terminal",
          openSignal: 0,
          runScriptActive: false,
          runScriptSessionId: null,
          collapsed: true,
        },
      },
      terminalTabsByWorktreeId: {},
    });
  });

  it("migrates removed debug console tab state to the default bottom tab", () => {
    sessionStorage.setItem(WORKSPACE_TERMINAL_UI_STORAGE_KEY, JSON.stringify({
      version: 1,
      runtimePid: 123,
      bottomPanelStateByWorktreeId: {
        wt1: {
          activeTab: "debug",
          openSignal: 1,
          runScriptActive: false,
          runScriptSessionId: null,
          collapsed: false,
        },
      },
      terminalTabsByWorktreeId: {},
    }));

    const persistedState = readPersistedWorkspaceTerminalUiState(sessionStorage);
    const restoredState = restoreWorkspaceTerminalUiState({
      persistedState,
      runtimePid: 123,
      terminalSessions: [],
    });

    expect(restoredState?.bottomPanelStateByWorktreeId.wt1?.activeTab).toBe("terminal");
  });

  it("normalizes removed debug console tab state already in memory", () => {
    const state = getBottomPanelState({
      wt1: {
        activeTab: "debug",
        openSignal: 1,
        runScriptActive: false,
        runScriptSessionId: null,
        collapsed: false,
      },
    }, "wt1");

    expect(state.activeTab).toBe("terminal");
  });
});
