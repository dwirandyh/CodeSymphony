import { describe, expect, it } from "vitest";
import {
  hasStartupNonCriticalDataReadyState,
  hasStartupThreadShellReadyState,
  hasStartupWorkspaceShellReadyState,
} from "./startupShellReadiness";

describe("startupShellReadiness", () => {
  it("treats fallback repository and worktree shell data as workspace ready", () => {
    expect(hasStartupWorkspaceShellReadyState({
      repositoryId: "repo-1",
      repositoryName: "CodeSymphony",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: null,
    })).toBe(true);
  });

  it("does not mark workspace ready when selected ids have no visible shell data", () => {
    expect(hasStartupWorkspaceShellReadyState({
      repositoryId: "repo-1",
      repositoryName: null,
      worktreeId: "wt-1",
      worktreeBranch: null,
      worktreePath: null,
    })).toBe(false);
  });

  it("treats fallback thread title as thread shell ready", () => {
    expect(hasStartupThreadShellReadyState({
      threadId: "thread-1",
      threadTitle: "Instant open",
    })).toBe(true);
  });

  it("does not mark thread shell ready without a visible title", () => {
    expect(hasStartupThreadShellReadyState({
      threadId: "thread-1",
      threadTitle: null,
    })).toBe(false);
  });

  it("unblocks non-critical startup data after selected thread timeline is ready", () => {
    expect(hasStartupNonCriticalDataReadyState({
      workspaceShellReady: true,
      startupThreadId: "thread-1",
      messageListEmptyState: null,
      repositoriesLoading: true,
      selectedRepositoryId: "repo-1",
      selectedWorktreeId: "wt-1",
      selectedThreadId: "thread-1",
    })).toBe(true);
  });

  it("keeps non-critical startup data blocked while selected thread still loads", () => {
    expect(hasStartupNonCriticalDataReadyState({
      workspaceShellReady: true,
      startupThreadId: "thread-1",
      messageListEmptyState: "loading-thread",
      repositoriesLoading: true,
      selectedRepositoryId: "repo-1",
      selectedWorktreeId: "wt-1",
      selectedThreadId: "thread-1",
    })).toBe(false);
  });

  it("unblocks non-critical startup data after empty workspace settles", () => {
    expect(hasStartupNonCriticalDataReadyState({
      workspaceShellReady: false,
      startupThreadId: null,
      messageListEmptyState: "no-thread-selected",
      repositoriesLoading: false,
      selectedRepositoryId: null,
      selectedWorktreeId: null,
      selectedThreadId: null,
    })).toBe(true);
  });
});
