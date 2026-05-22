import type { CliAgent } from "@codesymphony/shared-types";

type WorkspaceAgentCatalogAgent = CliAgent;

export function shouldLoadWorkspaceAgentCatalog(params: {
  enableNonCriticalWorkspaceData: boolean;
  loadAllAgentCatalogs: boolean;
  catalogAgent: WorkspaceAgentCatalogAgent;
  composerAgent: CliAgent;
}) {
  if (!params.enableNonCriticalWorkspaceData) {
    return false;
  }

  if (params.loadAllAgentCatalogs) {
    return true;
  }

  return params.composerAgent === params.catalogAgent;
}

export function shouldAutoLoadAllWorkspaceAgentCatalogs(params: {
  enableNonCriticalWorkspaceData: boolean;
  loadAllAgentCatalogs: boolean;
}) {
  return params.enableNonCriticalWorkspaceData && !params.loadAllAgentCatalogs;
}
