import type { CliAgent } from "@codesymphony/shared-types";

type WorkspaceModelCatalogAgent = Extract<CliAgent, "codex" | "cursor" | "opencode">;

export function shouldLoadWorkspaceAgentCatalog(params: {
  enableNonCriticalWorkspaceData: boolean;
  loadAllModelCatalogs: boolean;
  catalogAgent: WorkspaceModelCatalogAgent;
  composerAgent: CliAgent;
}) {
  if (!params.enableNonCriticalWorkspaceData) {
    return false;
  }

  if (params.loadAllModelCatalogs) {
    return true;
  }

  return params.composerAgent === params.catalogAgent;
}
