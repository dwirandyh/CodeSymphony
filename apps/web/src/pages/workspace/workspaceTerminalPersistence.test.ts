import { beforeEach, describe, expect, it } from "vitest";
import {
  readPersistedWorkspaceTerminalUiState,
  restoreWorkspaceTerminalUiState,
  WORKSPACE_TERMINAL_UI_STORAGE_KEY,
  writePersistedWorkspaceTerminalUiState,
} from "./workspaceTerminalPersistence";

describe("workspaceTerminalPersistence", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("restores terminal tabs and run sessions for the same runtime", () => {
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
          openSignal: 3,
          runScriptActive: false,
          runScriptSessionId: "wt1:script-runner:1",
          collapsed: false,
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
          openSignal: 1,
          runScriptActive: false,
          runScriptSessionId: null,
          collapsed: false,
        },
      },
      terminalTabsByWorktreeId: {},
    });
  });
});
