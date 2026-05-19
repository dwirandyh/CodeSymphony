import { describe, expect, it } from "vitest";
import {
  createWorkspaceLiveScopeSwitch,
  resolveLiveStatusDisplayState,
  shouldKeepWorkspaceLiveScopeSwitch,
  WORKSPACE_LIVE_SCOPE_SWITCH_MAX_MS,
} from "./workspaceLiveBadgeState";

describe("workspaceLiveBadgeState", () => {
  it("creates a scope switch transition when the selected worktree changes", () => {
    expect(createWorkspaceLiveScopeSwitch(
      {
        repositoryId: "repo-1",
        worktreeId: "wt-1",
        threadId: "thread-1",
      },
      {
        repositoryId: "repo-1",
        worktreeId: "wt-2",
        threadId: "thread-2",
      },
      1_000,
    )).toEqual({
      repositoryChanged: false,
      startedAtMs: 1_000,
      threadChanged: true,
      worktreeChanged: true,
    });
  });

  it("keeps a scope switch active while the new scope is still connecting", () => {
    const transition = createWorkspaceLiveScopeSwitch(
      {
        repositoryId: "repo-1",
        worktreeId: "wt-1",
        threadId: "thread-1",
      },
      {
        repositoryId: "repo-1",
        worktreeId: "wt-2",
        threadId: "thread-2",
      },
      1_000,
    );

    if (!transition) {
      throw new Error("Expected transition");
    }

    expect(shouldKeepWorkspaceLiveScopeSwitch({
      transition,
      nowMs: 5_000,
      hasChatThreadSelection: true,
      hasRepositorySelection: true,
      hasWorktreeSelection: true,
      chatThreadState: "reconnecting",
      gitStatusState: "healthy",
      repositoryBranchesState: "healthy",
      repositoryReviewsState: "healthy",
    })).toBe(true);
  });

  it("keeps a scope switch active while the new scope is stale but still settling", () => {
    const transition = createWorkspaceLiveScopeSwitch(
      {
        repositoryId: "repo-1",
        worktreeId: "wt-1",
        threadId: "thread-1",
      },
      {
        repositoryId: "repo-1",
        worktreeId: "wt-2",
        threadId: "thread-2",
      },
      1_000,
    );

    if (!transition) {
      throw new Error("Expected transition");
    }

    expect(shouldKeepWorkspaceLiveScopeSwitch({
      transition,
      nowMs: 5_000,
      hasChatThreadSelection: true,
      hasRepositorySelection: true,
      hasWorktreeSelection: true,
      chatThreadState: "healthy",
      gitStatusState: "stale",
      repositoryBranchesState: "healthy",
      repositoryReviewsState: "healthy",
    })).toBe(true);
  });

  it("drops a scope switch once the pending resources settle", () => {
    const transition = createWorkspaceLiveScopeSwitch(
      {
        repositoryId: "repo-1",
        worktreeId: "wt-1",
        threadId: "thread-1",
      },
      {
        repositoryId: "repo-1",
        worktreeId: "wt-2",
        threadId: "thread-2",
      },
      1_000,
    );

    if (!transition) {
      throw new Error("Expected transition");
    }

    expect(shouldKeepWorkspaceLiveScopeSwitch({
      transition,
      nowMs: 5_000,
      hasChatThreadSelection: true,
      hasRepositorySelection: true,
      hasWorktreeSelection: true,
      chatThreadState: "healthy",
      gitStatusState: "healthy",
      repositoryBranchesState: "healthy",
      repositoryReviewsState: "healthy",
    })).toBe(false);
  });

  it("expires a scope switch after the maximum switching window", () => {
    const transition = createWorkspaceLiveScopeSwitch(
      {
        repositoryId: "repo-1",
        worktreeId: "wt-1",
        threadId: "thread-1",
      },
      {
        repositoryId: "repo-2",
        worktreeId: "wt-2",
        threadId: "thread-2",
      },
      1_000,
    );

    if (!transition) {
      throw new Error("Expected transition");
    }

    expect(shouldKeepWorkspaceLiveScopeSwitch({
      transition,
      nowMs: 1_000 + WORKSPACE_LIVE_SCOPE_SWITCH_MAX_MS + 1,
      hasChatThreadSelection: true,
      hasRepositorySelection: true,
      hasWorktreeSelection: true,
      chatThreadState: "reconnecting",
      gitStatusState: "reconnecting",
      repositoryBranchesState: "reconnecting",
      repositoryReviewsState: "reconnecting",
    })).toBe(false);
  });

  it("formats scope-driven reconnects as switching without hiding unavailable worktrees", () => {
    expect(resolveLiveStatusDisplayState({
      connectionState: "reconnecting",
      displayStateOverride: "switching",
    })).toBe("switching");

    expect(resolveLiveStatusDisplayState({
      connectionState: "stale",
      displayStateOverride: "switching",
    })).toBe("switching");

    expect(resolveLiveStatusDisplayState({
      connectionState: "exhausted",
      displayStateOverride: "switching",
      errorMessage: "Worktree path not found: /tmp/codesymphony. Create a new worktree from Repository panel.",
    })).toBe("unavailable");
  });
});
