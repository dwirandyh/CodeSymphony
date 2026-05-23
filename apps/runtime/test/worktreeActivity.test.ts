import { beforeEach, describe, expect, it, vi } from "vitest";

const { invalidateCachedWorktreeGitDataMock } = vi.hoisted(() => ({
  invalidateCachedWorktreeGitDataMock: vi.fn(),
}));

vi.mock("../src/services/worktreeGitQueryCache.js", () => ({
  invalidateCachedWorktreeGitData: invalidateCachedWorktreeGitDataMock,
}));

import { publishWorktreeActivity, WORKTREE_ACTIVITY } from "../src/services/worktreeActivity";

describe("worktreeActivity", () => {
  const workspaceEventHub = {
    emit: vi.fn(),
  };
  const worktree = {
    id: "wt-1",
    repositoryId: "repo-1",
  };

  beforeEach(() => {
    workspaceEventHub.emit.mockReset();
    invalidateCachedWorktreeGitDataMock.mockReset();
  });

  it("publishes a file save as one worktree update with git cache invalidation", () => {
    publishWorktreeActivity({
      workspaceEventHub,
      worktree,
      activity: WORKTREE_ACTIVITY.FILE_SAVED,
    });

    expect(invalidateCachedWorktreeGitDataMock).toHaveBeenCalledWith("wt-1");
    expect(workspaceEventHub.emit).toHaveBeenCalledTimes(1);
    expect(workspaceEventHub.emit).toHaveBeenCalledWith("worktree.updated", {
      repositoryId: "repo-1",
      worktreeId: "wt-1",
    });
  });

  it("publishes watcher file changes to both file and git projections", () => {
    const onFilesChanged = vi.fn();
    const onGitChanged = vi.fn();

    publishWorktreeActivity({
      workspaceEventHub,
      worktree,
      activity: WORKTREE_ACTIVITY.WATCHER_FILES_CHANGED,
      onFilesChanged,
      onGitChanged,
    });

    expect(onFilesChanged).toHaveBeenCalledTimes(1);
    expect(onGitChanged).toHaveBeenCalledTimes(1);
    expect(invalidateCachedWorktreeGitDataMock).toHaveBeenCalledWith("wt-1");
    expect(workspaceEventHub.emit.mock.calls).toEqual([
      ["worktree.files.updated", { repositoryId: "repo-1", worktreeId: "wt-1" }],
      ["worktree.git.updated", { repositoryId: "repo-1", worktreeId: "wt-1" }],
    ]);
  });
});
