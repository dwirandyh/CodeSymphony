type WorkspaceInitialSurfacePreloadDependencies = {
  loadBottomPanel: () => Promise<unknown>;
  loadChatMessageList: () => Promise<unknown>;
  loadComposer: () => Promise<unknown>;
  loadWorkspaceEmptyState: () => Promise<unknown>;
  loadWorkspaceHeader: () => Promise<unknown>;
  loadWorkspaceRightPanel: () => Promise<unknown>;
  loadWorkspaceSidebar: () => Promise<unknown>;
};

type WorkspaceRouteSurfacePreloadDependencies = {
  loadCodeEditorPanel: () => Promise<unknown>;
  loadDiffReviewPanel: () => Promise<unknown>;
  loadWorkspaceAutomationsPanel: () => Promise<unknown>;
};

type WorkspaceRequestedStartupView = "automations" | "chat" | "file" | "review";

let initialWorkspaceSurfacePreloadStarted = false;

function preloadSafely(loader: () => Promise<unknown>) {
  void loader().catch(() => {});
}

export function startWorkspaceInitialSurfacePreload(
  dependencies: WorkspaceInitialSurfacePreloadDependencies,
) {
  if (initialWorkspaceSurfacePreloadStarted) {
    return;
  }

  initialWorkspaceSurfacePreloadStarted = true;

  preloadSafely(dependencies.loadWorkspaceSidebar);
  preloadSafely(dependencies.loadWorkspaceHeader);
  preloadSafely(dependencies.loadChatMessageList);
  preloadSafely(dependencies.loadComposer);
  preloadSafely(dependencies.loadBottomPanel);
  preloadSafely(dependencies.loadWorkspaceRightPanel);
  preloadSafely(dependencies.loadWorkspaceEmptyState);
}

export function resolveRequestedWorkspaceStartupView(
  search: string,
): WorkspaceRequestedStartupView {
  const searchParams = new URLSearchParams(search);
  const requestedView = searchParams.get("view");

  if (
    requestedView === "file"
    || requestedView === "review"
    || requestedView === "automations"
  ) {
    return requestedView;
  }

  return "chat";
}

export function preloadRequestedWorkspaceStartupView(
  requestedView: WorkspaceRequestedStartupView,
  dependencies: WorkspaceRouteSurfacePreloadDependencies,
) {
  if (requestedView === "file") {
    preloadSafely(dependencies.loadCodeEditorPanel);
    return;
  }

  if (requestedView === "review") {
    preloadSafely(dependencies.loadDiffReviewPanel);
    return;
  }

  if (requestedView === "automations") {
    preloadSafely(dependencies.loadWorkspaceAutomationsPanel);
  }
}

export function resetWorkspaceStartupSurfacePreloadForTest() {
  initialWorkspaceSurfacePreloadStarted = false;
}
