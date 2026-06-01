import { describe, expect, it } from "vitest";
import { shouldSuppressStartupFallbackSearchUpdate } from "./startupSelectionNavigation";

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
