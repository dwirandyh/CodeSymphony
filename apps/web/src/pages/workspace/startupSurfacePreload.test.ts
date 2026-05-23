import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  preloadRequestedWorkspaceStartupView,
  resetWorkspaceStartupSurfacePreloadForTest,
  resolveRequestedWorkspaceStartupView,
  startWorkspaceInitialSurfacePreload,
} from "./startupSurfacePreload";

describe("startupSurfacePreload", () => {
  beforeEach(() => {
    resetWorkspaceStartupSurfacePreloadForTest();
  });

  it("starts the initial workspace surface preload only once", () => {
    const dependencies = {
      loadBottomPanel: vi.fn().mockResolvedValue(undefined),
      loadChatMessageList: vi.fn().mockResolvedValue(undefined),
      loadComposer: vi.fn().mockResolvedValue(undefined),
      loadWorkspaceEmptyState: vi.fn().mockResolvedValue(undefined),
      loadWorkspaceHeader: vi.fn().mockResolvedValue(undefined),
      loadWorkspaceRightPanel: vi.fn().mockResolvedValue(undefined),
      loadWorkspaceSidebar: vi.fn().mockResolvedValue(undefined),
    };

    startWorkspaceInitialSurfacePreload(dependencies);
    startWorkspaceInitialSurfacePreload(dependencies);

    expect(dependencies.loadWorkspaceSidebar).toHaveBeenCalledTimes(1);
    expect(dependencies.loadWorkspaceHeader).toHaveBeenCalledTimes(1);
    expect(dependencies.loadChatMessageList).toHaveBeenCalledTimes(1);
    expect(dependencies.loadComposer).toHaveBeenCalledTimes(1);
    expect(dependencies.loadBottomPanel).toHaveBeenCalledTimes(1);
    expect(dependencies.loadWorkspaceRightPanel).toHaveBeenCalledTimes(1);
    expect(dependencies.loadWorkspaceEmptyState).toHaveBeenCalledTimes(1);
  });

  it("defaults to chat when the route does not request a special view", () => {
    expect(resolveRequestedWorkspaceStartupView("")).toBe("chat");
    expect(resolveRequestedWorkspaceStartupView("?threadId=thread-1")).toBe("chat");
    expect(resolveRequestedWorkspaceStartupView("?view=chat")).toBe("chat");
  });

  it("recognizes file, review, and automations startup views", () => {
    expect(resolveRequestedWorkspaceStartupView("?view=file")).toBe("file");
    expect(resolveRequestedWorkspaceStartupView("?view=review")).toBe("review");
    expect(resolveRequestedWorkspaceStartupView("?view=automations")).toBe("automations");
  });

  it("preloads only the route-specific surface for the requested view", () => {
    const dependencies = {
      loadCodeEditorPanel: vi.fn().mockResolvedValue(undefined),
      loadDiffReviewPanel: vi.fn().mockResolvedValue(undefined),
      loadWorkspaceAutomationsPanel: vi.fn().mockResolvedValue(undefined),
    };

    preloadRequestedWorkspaceStartupView("file", dependencies);
    expect(dependencies.loadCodeEditorPanel).toHaveBeenCalledTimes(1);
    expect(dependencies.loadDiffReviewPanel).not.toHaveBeenCalled();
    expect(dependencies.loadWorkspaceAutomationsPanel).not.toHaveBeenCalled();

    preloadRequestedWorkspaceStartupView("review", dependencies);
    expect(dependencies.loadDiffReviewPanel).toHaveBeenCalledTimes(1);

    preloadRequestedWorkspaceStartupView("automations", dependencies);
    expect(dependencies.loadWorkspaceAutomationsPanel).toHaveBeenCalledTimes(1);

    preloadRequestedWorkspaceStartupView("chat", dependencies);
    expect(dependencies.loadCodeEditorPanel).toHaveBeenCalledTimes(1);
    expect(dependencies.loadDiffReviewPanel).toHaveBeenCalledTimes(1);
    expect(dependencies.loadWorkspaceAutomationsPanel).toHaveBeenCalledTimes(1);
  });
});
