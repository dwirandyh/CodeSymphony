import { describe, expect, it } from "vitest";
import {
  shouldClearPersistedStartupShell,
  shouldReleaseStartupSelectionFallback,
  shouldPreserveStartupThreadFallback,
} from "./startupShellPersistence";

describe("startupShellPersistence", () => {
  it("keeps persisted shell while critical workspace data is still deferred", () => {
    expect(shouldClearPersistedStartupShell({
      criticalWorkspaceDataEnabled: false,
      hasLiveShellData: false,
      hasUnavailableSelectedWorktree: false,
      loadingRepos: false,
      repositoriesCount: 0,
      runtimeState: "ready",
    })).toBe(false);
  });

  it("clears persisted shell once live startup settles with no repositories", () => {
    expect(shouldClearPersistedStartupShell({
      criticalWorkspaceDataEnabled: true,
      hasLiveShellData: false,
      hasUnavailableSelectedWorktree: false,
      loadingRepos: false,
      repositoriesCount: 0,
      runtimeState: "ready",
    })).toBe(true);
  });

  it("keeps persisted shell while runtime still reconnects or repositories still load", () => {
    expect(shouldClearPersistedStartupShell({
      criticalWorkspaceDataEnabled: true,
      hasLiveShellData: false,
      hasUnavailableSelectedWorktree: false,
      loadingRepos: true,
      repositoriesCount: 0,
      runtimeState: "reconnecting",
    })).toBe(false);
  });

  it("clears persisted shell when the selected worktree is known to be unavailable", () => {
    expect(shouldClearPersistedStartupShell({
      criticalWorkspaceDataEnabled: true,
      hasLiveShellData: false,
      hasUnavailableSelectedWorktree: true,
      loadingRepos: false,
      repositoriesCount: 3,
      runtimeState: "reconnecting",
    })).toBe(true);
  });

  it("preserves thread fallback while startup is still unresolved", () => {
    expect(shouldPreserveStartupThreadFallback({
      threadFallbackActive: true,
      loadingRepos: true,
      messageListEmptyState: "no-thread-selected",
      runtimeState: "reconnecting",
    })).toBe(true);

    expect(shouldPreserveStartupThreadFallback({
      threadFallbackActive: true,
      loadingRepos: false,
      messageListEmptyState: "loading-thread",
      runtimeState: "ready",
    })).toBe(true);
  });

  it("stops preserving thread fallback once startup is ready and threadless", () => {
    expect(shouldPreserveStartupThreadFallback({
      threadFallbackActive: true,
      loadingRepos: false,
      messageListEmptyState: "no-thread-selected",
      runtimeState: "ready",
    })).toBe(false);
  });

  it("releases startup selection fallback after a live thread selection settles", () => {
    expect(shouldReleaseStartupSelectionFallback({
      selectionFallbackActive: true,
      loadingRepos: false,
      messageListEmptyState: "existing-thread-empty",
      runtimeState: "ready",
      selectedThreadId: "thread-1",
      selectedWorktreeId: "wt-1",
    })).toBe(true);
  });

  it("releases startup selection fallback after startup settles without a thread", () => {
    expect(shouldReleaseStartupSelectionFallback({
      selectionFallbackActive: true,
      loadingRepos: false,
      messageListEmptyState: "no-thread-selected",
      runtimeState: "ready",
      selectedThreadId: null,
      selectedWorktreeId: "wt-1",
    })).toBe(true);
  });

  it("keeps startup selection fallback while the requested thread is still resolving", () => {
    expect(shouldReleaseStartupSelectionFallback({
      selectionFallbackActive: true,
      loadingRepos: false,
      messageListEmptyState: "loading-thread",
      runtimeState: "ready",
      selectedThreadId: null,
      selectedWorktreeId: "wt-1",
    })).toBe(false);
  });
});
