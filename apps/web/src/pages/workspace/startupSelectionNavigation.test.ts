import { describe, expect, it } from "vitest";
import {
  resolveThreadIdOnSelectionChange,
  shouldSuppressStartupFallbackSearchUpdate,
} from "./startupSelectionNavigation";

const baseArgs = {
  startupSelectionFallbackActive: true,
  routeRepoId: null,
  routeWorktreeId: null,
  pendingRepoId: null,
  pendingWorktreeId: null,
  restoredRepoId: "repo-1",
  restoredWorktreeId: "wt-stale",
  nextRepoId: "repo-1",
  nextWorktreeId: "wt-stale",
};

describe("resolveThreadIdOnSelectionChange", () => {
  it("preserves route thread when startup selection lands on the requested worktree", () => {
    expect(resolveThreadIdOnSelectionChange({
      worktreeChanged: true,
      shouldReusePendingThreadId: false,
      routeWorktreeId: "wt-target",
      routeThreadId: "thread-route",
      nextWorktreeId: "wt-target",
    })).toEqual({ threadId: "thread-route" });
  });

  it("clears thread when user switches to a different worktree", () => {
    expect(resolveThreadIdOnSelectionChange({
      worktreeChanged: true,
      shouldReusePendingThreadId: false,
      routeWorktreeId: "wt-target",
      routeThreadId: "thread-route",
      nextWorktreeId: "wt-other",
    })).toEqual({ threadId: undefined });
  });

  it("reuses pending thread when pending worktree matches", () => {
    expect(resolveThreadIdOnSelectionChange({
      worktreeChanged: true,
      shouldReusePendingThreadId: true,
      pendingThreadId: "thread-pending",
      nextWorktreeId: "wt-target",
    })).toEqual({ threadId: "thread-pending" });
  });

  it("does not touch thread when worktree is unchanged", () => {
    expect(resolveThreadIdOnSelectionChange({
      worktreeChanged: false,
      shouldReusePendingThreadId: false,
      routeThreadId: "thread-route",
      nextWorktreeId: "wt-target",
    })).toEqual({});
  });
});

describe("shouldSuppressStartupFallbackSearchUpdate", () => {
  it("suppresses promoting a snapshot-only startup selection into the URL", () => {
    expect(shouldSuppressStartupFallbackSearchUpdate(baseArgs)).toBe(true);
  });

  it("does not suppress explicit route selections", () => {
    expect(shouldSuppressStartupFallbackSearchUpdate({
      ...baseArgs,
      routeWorktreeId: "wt-stale",
    })).toBe(false);
  });

  it("does not suppress deliberate pending worktree navigation", () => {
    expect(shouldSuppressStartupFallbackSearchUpdate({
      ...baseArgs,
      pendingWorktreeId: "wt-stale",
    })).toBe(false);
  });

  it("does not suppress fallback changes away from the restored worktree", () => {
    expect(shouldSuppressStartupFallbackSearchUpdate({
      ...baseArgs,
      nextWorktreeId: "wt-root",
    })).toBe(false);
  });
});
