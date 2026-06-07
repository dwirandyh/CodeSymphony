import type { TerminalSessionInfo } from "../../lib/api";
import type { TerminalTab } from "@codesymphony/shared-types";
import type { WorkspaceTerminalTab } from "../../components/workspace/WorkspaceHeader";

export const WORKSPACE_TERMINAL_UI_STORAGE_KEY = "codesymphony:workspace:terminal-ui:v1";
export const DEFAULT_BOTTOM_PANEL_TAB = "terminal";
const AVAILABLE_BOTTOM_PANEL_TABS = new Set(["setup-script", "terminal", "run"]);

export type BottomPanelWorktreeState = {
  activeTab: string;
  openSignal: number;
  runScriptActive: boolean;
  runScriptSessionId: string | null;
  collapsed: boolean;
};

export type WorkspaceTerminalTabsState = {
  tabs: WorkspaceTerminalTab[];
  activeTabId: string | null;
  visible: boolean;
};

type PersistedWorkspaceTerminalUiState = {
  version: 1;
  runtimePid: number;
  bottomPanelStateByWorktreeId: Record<string, BottomPanelWorktreeState>;
  terminalTabsByWorktreeId: Record<string, WorkspaceTerminalTabsState>;
};

const EMPTY_TERMINAL_TABS_STATE: WorkspaceTerminalTabsState = {
  tabs: [],
  activeTabId: null,
  visible: false,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeNonNegativeInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function sanitizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function sanitizeNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sanitizeTerminalTab(value: unknown): WorkspaceTerminalTab | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const id = sanitizeString(value.id).trim();
  const sessionId = sanitizeString(value.sessionId).trim();
  const title = sanitizeString(value.title).trim();
  if (id.length === 0 || sessionId.length === 0 || title.length === 0) {
    return null;
  }

  return {
    id,
    sessionId,
    title,
  };
}

function sanitizeBottomPanelState(value: unknown): BottomPanelWorktreeState | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return {
    activeTab: normalizeBottomPanelActiveTab(sanitizeString(value.activeTab, DEFAULT_BOTTOM_PANEL_TAB)),
    openSignal: sanitizeNonNegativeInteger(value.openSignal, 0),
    runScriptActive: sanitizeBoolean(value.runScriptActive, false),
    runScriptSessionId: sanitizeNullableString(value.runScriptSessionId),
    collapsed: sanitizeBoolean(value.collapsed, true),
  };
}

function normalizeBottomPanelActiveTab(activeTab: string): string {
  return AVAILABLE_BOTTOM_PANEL_TABS.has(activeTab) ? activeTab : DEFAULT_BOTTOM_PANEL_TAB;
}

function sanitizeTerminalTabsState(value: unknown): WorkspaceTerminalTabsState | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const tabs = Array.isArray(value.tabs)
    ? value.tabs
      .map((tab) => sanitizeTerminalTab(tab))
      .filter((tab): tab is WorkspaceTerminalTab => tab !== null)
    : [];
  const activeTabId = sanitizeNullableString(value.activeTabId);

  return {
    tabs,
    activeTabId: activeTabId && tabs.some((tab) => tab.id === activeTabId) ? activeTabId : null,
    visible: sanitizeBoolean(value.visible, false),
  };
}

function sanitizeRecord<T>(
  value: unknown,
  sanitizeEntry: (entry: unknown) => T | null,
): Record<string, T> {
  if (!isPlainObject(value)) {
    return {};
  }

  const result: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    const sanitizedKey = key.trim();
    if (sanitizedKey.length === 0) {
      continue;
    }

    const sanitizedEntry = sanitizeEntry(entry);
    if (sanitizedEntry) {
      result[sanitizedKey] = sanitizedEntry;
    }
  }

  return result;
}

export function reconcileWorkspaceTerminalTabs(input: {
  current: WorkspaceTerminalTabsState;
  serverTabs: TerminalTab[];
}): WorkspaceTerminalTabsState {
  const { current, serverTabs } = input;

  const orderedTabs = [...serverTabs]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((tab) => ({ id: tab.id, sessionId: tab.sessionId, title: tab.title }));

  const tabsUnchanged =
    orderedTabs.length === current.tabs.length
    && orderedTabs.every((tab, index) => {
      const existing = current.tabs[index];
      return existing
        && existing.id === tab.id
        && existing.sessionId === tab.sessionId
        && existing.title === tab.title;
    });

  const activeTabId = current.activeTabId && orderedTabs.some((tab) => tab.id === current.activeTabId)
    ? current.activeTabId
    : orderedTabs[0]?.id ?? null;

  const visible = current.visible && orderedTabs.length > 0;

  if (
    tabsUnchanged
    && activeTabId === current.activeTabId
    && visible === current.visible
  ) {
    return current;
  }

  return {
    tabs: orderedTabs,
    activeTabId,
    visible,
  };
}

export type CloseWorkspaceTerminalTabResult = {
  state: WorkspaceTerminalTabsState;
  sessionIdToKill: string | null;
};

// Close a terminal tab and report which PTY session the caller must kill
// server-side. The session id is derived synchronously from the passed-in
// state — never inside a React state updater, whose body runs later during
// render. Reading it inside the updater leaves the caller's `if` check looking
// at a stale `null`, so the server DELETE never fires and the tab resurfaces
// the next time the tab list reconciles from the server.
export function closeWorkspaceTerminalTab(
  current: WorkspaceTerminalTabsState,
  terminalTabId: string,
): CloseWorkspaceTerminalTabResult {
  const terminalIndex = current.tabs.findIndex((tab) => tab.id === terminalTabId);
  if (terminalIndex < 0) {
    return { state: current, sessionIdToKill: null };
  }

  const sessionIdToKill = current.tabs[terminalIndex]!.sessionId;
  const nextTabs = current.tabs.filter((tab) => tab.id !== terminalTabId);
  const nextActiveTabId = current.activeTabId === terminalTabId
    ? (nextTabs[terminalIndex] ?? nextTabs[terminalIndex - 1] ?? null)?.id ?? null
    : current.activeTabId;

  return {
    state: {
      ...current,
      tabs: nextTabs,
      activeTabId: nextActiveTabId,
      visible: current.visible && nextActiveTabId !== null,
    },
    sessionIdToKill,
  };
}

export function getBottomPanelState(
  state: Record<string, BottomPanelWorktreeState>,
  worktreeId: string | null | undefined,
): BottomPanelWorktreeState {
  if (!worktreeId) {
    return {
      activeTab: DEFAULT_BOTTOM_PANEL_TAB,
      openSignal: 0,
      runScriptActive: false,
      runScriptSessionId: null,
      collapsed: true,
    };
  }

  const current = state[worktreeId];
  if (current) {
    return {
      ...current,
      activeTab: normalizeBottomPanelActiveTab(current.activeTab),
    };
  }

  return {
    activeTab: DEFAULT_BOTTOM_PANEL_TAB,
    openSignal: 0,
    runScriptActive: false,
    runScriptSessionId: null,
    collapsed: true,
  };
}

export function getTerminalTabsState(
  state: Record<string, WorkspaceTerminalTabsState>,
  worktreeId: string | null | undefined,
): WorkspaceTerminalTabsState {
  if (!worktreeId) {
    return EMPTY_TERMINAL_TABS_STATE;
  }

  return state[worktreeId] ?? EMPTY_TERMINAL_TABS_STATE;
}

export function readPersistedWorkspaceTerminalUiState(
  storage: Pick<Storage, "getItem">,
): PersistedWorkspaceTerminalUiState | null {
  const raw = storage.getItem(WORKSPACE_TERMINAL_UI_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed) || parsed.version !== 1 || !Number.isInteger(parsed.runtimePid)) {
      return null;
    }

    return {
      version: 1,
      runtimePid: Number(parsed.runtimePid),
      bottomPanelStateByWorktreeId: sanitizeRecord(parsed.bottomPanelStateByWorktreeId, sanitizeBottomPanelState),
      terminalTabsByWorktreeId: sanitizeRecord(parsed.terminalTabsByWorktreeId, sanitizeTerminalTabsState),
    };
  } catch {
    return null;
  }
}

export function writePersistedWorkspaceTerminalUiState(
  storage: Pick<Storage, "setItem">,
  input: Omit<PersistedWorkspaceTerminalUiState, "version">,
): void {
  storage.setItem(
    WORKSPACE_TERMINAL_UI_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      runtimePid: input.runtimePid,
      bottomPanelStateByWorktreeId: input.bottomPanelStateByWorktreeId,
      terminalTabsByWorktreeId: input.terminalTabsByWorktreeId,
    } satisfies PersistedWorkspaceTerminalUiState),
  );
}

export function restoreWorkspaceTerminalUiState(input: {
  persistedState: PersistedWorkspaceTerminalUiState | null;
  runtimePid: number;
  terminalSessions: TerminalSessionInfo[];
}): {
  bottomPanelStateByWorktreeId: Record<string, BottomPanelWorktreeState>;
  terminalTabsByWorktreeId: Record<string, WorkspaceTerminalTabsState>;
} | null {
  const { persistedState, runtimePid, terminalSessions } = input;
  if (!persistedState || persistedState.runtimePid !== runtimePid) {
    return null;
  }

  const terminalSessionsById = new Map(
    terminalSessions.map((session) => [session.sessionId, session] as const),
  );

  const bottomPanelStateByWorktreeId: Record<string, BottomPanelWorktreeState> = {};
  for (const [worktreeId, state] of Object.entries(persistedState.bottomPanelStateByWorktreeId)) {
    const runSession = state.runScriptSessionId
      ? terminalSessionsById.get(state.runScriptSessionId) ?? null
      : null;

    bottomPanelStateByWorktreeId[worktreeId] = {
      activeTab: !runSession && state.activeTab === "run" ? DEFAULT_BOTTOM_PANEL_TAB : state.activeTab,
      // Treat startup restore as a fresh frame: do not replay stale "open panel" signals
      // or reopen the bottom panel before the live workspace has settled.
      openSignal: 0,
      runScriptActive: runSession?.active ?? false,
      runScriptSessionId: runSession?.sessionId ?? null,
      collapsed: true,
    };
  }

  const terminalTabsByWorktreeId: Record<string, WorkspaceTerminalTabsState> = {};
  for (const [worktreeId, state] of Object.entries(persistedState.terminalTabsByWorktreeId)) {
    const tabs = state.tabs.filter((tab) => terminalSessionsById.has(tab.sessionId));
    const activeTabId = state.activeTabId && tabs.some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : tabs[0]?.id ?? null;

    terminalTabsByWorktreeId[worktreeId] = {
      tabs,
      activeTabId,
      visible: state.visible && tabs.length > 0,
    };
  }

  return {
    bottomPanelStateByWorktreeId,
    terminalTabsByWorktreeId,
  };
}
