import { createContext, useContext } from "react";
import type { StartupShellSnapshot } from "../../lib/startupShellSnapshot";

export type WorkspaceStartupRuntimeState =
  | "ready"
  | "restoring"
  | "reconnecting"
  | "stale"
  | "offline";

export type WorkspaceStartupState = {
  desktopShell: boolean;
  hasPersistedShell: boolean;
  runtimeState: WorkspaceStartupRuntimeState;
  snapshot: StartupShellSnapshot | null;
};

const DEFAULT_WORKSPACE_STARTUP_STATE: WorkspaceStartupState = {
  desktopShell: false,
  hasPersistedShell: false,
  runtimeState: "ready",
  snapshot: null,
};

export const WorkspaceStartupStateContext = createContext<WorkspaceStartupState>(
  DEFAULT_WORKSPACE_STARTUP_STATE,
);

export function useWorkspaceStartupState() {
  return useContext(WorkspaceStartupStateContext);
}
