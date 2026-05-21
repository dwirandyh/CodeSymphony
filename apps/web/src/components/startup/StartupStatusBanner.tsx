import type { StartupShellSnapshot } from "../../lib/startupShellSnapshot";
import type { WorkspaceStartupRuntimeState } from "./workspaceStartupState";

export function StartupStatusBanner(_: {
  runtimeState: WorkspaceStartupRuntimeState;
  snapshot: StartupShellSnapshot | null;
  className?: string;
}) {
  return null;
}
