import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadStartupShellSnapshot, STARTUP_SHELL_SNAPSHOT_STORAGE_KEY } from "../lib/startupShellSnapshot";

describe("workspaceShellState", () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.removeItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    window.localStorage.removeItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY);
  });

  it("writes, reads, updates, and clears last known workspace shell snapshot", async () => {
    const {
      readWorkspaceShellStateSnapshot,
      writeWorkspaceShellStateSnapshot,
      resetWorkspaceShellStateCollectionForTest,
    } = await import("./workspaceShellState");

    const initialSnapshot = {
      version: 1 as const,
      capturedAt: "2026-05-19T14:00:00.000Z",
      repoId: "repo-1",
      repoName: "CodeSymphony",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Instant open",
      threadStatus: "idle",
    };

    expect(readWorkspaceShellStateSnapshot()).toBeNull();

    writeWorkspaceShellStateSnapshot(initialSnapshot);
    expect(readWorkspaceShellStateSnapshot()).toEqual(initialSnapshot);
    expect(loadStartupShellSnapshot()).toEqual(initialSnapshot);

    writeWorkspaceShellStateSnapshot({
      ...initialSnapshot,
      threadTitle: "Phase 2",
      capturedAt: "2026-05-19T14:01:00.000Z",
    });
    expect(readWorkspaceShellStateSnapshot()).toEqual({
      ...initialSnapshot,
      threadTitle: "Phase 2",
      capturedAt: "2026-05-19T14:01:00.000Z",
    });
    expect(loadStartupShellSnapshot()).toEqual({
      ...initialSnapshot,
      threadTitle: "Phase 2",
      capturedAt: "2026-05-19T14:01:00.000Z",
    });

    writeWorkspaceShellStateSnapshot(null);
    expect(readWorkspaceShellStateSnapshot()).toBeNull();

    await resetWorkspaceShellStateCollectionForTest();
  });

  it("drops invalid persisted workspace shell rows when schema version mismatches", async () => {
    const {
      readWorkspaceShellStateSnapshot,
      resetWorkspaceShellStateCollectionForTest,
    } = await import("./workspaceShellState");

    window.localStorage.setItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY, JSON.stringify({
      "s:workspace-shell": {
        versionKey: "invalid-schema",
        data: {
          id: "workspace-shell",
          version: 2,
          capturedAt: "2026-05-19T14:00:00.000Z",
          repoId: "repo-1",
          repoName: "CodeSymphony",
          worktreeId: "wt-1",
          worktreeBranch: "main",
          worktreePath: "/tmp/repo",
          worktreeStatus: "active",
          threadId: "thread-1",
          threadTitle: "Instant open",
          threadStatus: "idle",
        },
      },
    }));

    expect(readWorkspaceShellStateSnapshot()).toBeNull();
    expect(loadStartupShellSnapshot()).toBeNull();

    await resetWorkspaceShellStateCollectionForTest();
  });
});
