import type { WorkspaceSearch } from "../../routes/index";

export function shouldScheduleWorkspacePanelPreload(params: {
  activeView: WorkspaceSearch["view"] | undefined;
  alreadyPreloaded: boolean;
  enableNonCriticalWorkspaceData: boolean;
  hasSelectedWorktree: boolean;
}) {
  if (params.alreadyPreloaded) {
    return false;
  }

  if (!params.enableNonCriticalWorkspaceData || !params.hasSelectedWorktree) {
    return false;
  }

  return params.activeView !== "file" && params.activeView !== "review";
}
