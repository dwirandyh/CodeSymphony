import type { TerminalSessionInfo } from "../../lib/api";
import type { WorkspaceTerminalTab } from "../../components/workspace/WorkspaceHeader";

export const WORKSPACE_TERMINAL_UI_STORAGE_KEY = "codesymphony:workspace:terminal-ui:v1";
export const DEFAULT_BOTTOM_PANEL_TAB = "terminal";

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
  nextOrdinal: number;
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
  nextOrdinal: 1,
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
    activeTab: sanitizeString(value.activeTab, DEFAULT_BOTTOM_PANEL_TAB),
    openSignal: sanitizeNonNegativeInteger(value.openSignal, 0),
    runScriptActive: sanitizeBoolean(value.runScriptActive, false),
    runScriptSessionId: sanitizeNullableString(value.runScriptSessionId),
    collapsed: sanitizeBoolean(value.collapsed, true),
  };
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
    nextOrdinal: Math.max(1, sanitizeNonNegativeInteger(value.nextOrdinal, 1)),
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

function resolveNextTerminalOrdinal(tabs: WorkspaceTerminalTab[], fallback: number): number {
  let highestOrdinal = 0;

  for (const tab of tabs) {
    const match = /^Terminal(?: (\d+))?$/u.exec(tab.title);
    if (!match) {
      continue;
    }

    const ordinal = match[1] ? Number(match[1]) : 1;
    if (Number.isInteger(ordinal) && ordinal > highestOrdinal) {
      highestOrdinal = ordinal;
    }
  }

  return Math.max(fallback, highestOrdinal + 1, 1);
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

  return state[worktreeId] ?? {
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
      openSignal: state.openSignal,
      runScriptActive: runSession?.active ?? false,
      runScriptSessionId: runSession?.sessionId ?? null,
      collapsed: state.collapsed,
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
      nextOrdinal: resolveNextTerminalOrdinal(tabs, state.nextOrdinal),
    };
  }

  return {
    bottomPanelStateByWorktreeId,
    terminalTabsByWorktreeId,
  };
}
