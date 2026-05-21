import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildStartupShellSnapshot,
  hasStartupShellSnapshot,
  loadStartupShellSnapshot,
  mergeStartupShellSnapshotInputFromFallback,
  primeStartupShellSnapshot,
  readPersistedStartupShellSnapshot,
  resolveStartupShellFallbackState,
  resolveStartupWorkspaceSelection,
  saveStartupShellSnapshot,
  STARTUP_SHELL_SNAPSHOT_STORAGE_KEY,
} from "./startupShellSnapshot";

describe("startupShellSnapshot", () => {
  beforeEach(() => {
    window.localStorage.removeItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY);
    delete window.__CS_STARTUP_IGNORE_STORED_SNAPSHOT__;
    delete window.__CS_STARTUP_SHELL_SNAPSHOT_OVERRIDE__;
  });

  afterEach(() => {
    window.localStorage.removeItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY);
    delete window.__CS_STARTUP_IGNORE_STORED_SNAPSHOT__;
    delete window.__CS_STARTUP_SHELL_SNAPSHOT_OVERRIDE__;
  });

  it("builds a normalized restorable snapshot", () => {
    const snapshot = buildStartupShellSnapshot({
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: " repo-1 ",
      repoName: " Repo One ",
      worktreeId: " wt-1 ",
      worktreeBranch: " main ",
      worktreePath: " /tmp/repo ",
      worktreeStatus: " active ",
      threadId: " thread-1 ",
      threadTitle: " Fix startup ",
      threadStatus: " idle ",
    });

    expect(snapshot).toEqual({
      version: 1,
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
    });
    expect(hasStartupShellSnapshot(snapshot)).toBe(true);
  });

  it("returns null when there is no usable shell data", () => {
    expect(buildStartupShellSnapshot({
      repoId: null,
      repoName: null,
      worktreeId: null,
      worktreeBranch: null,
      worktreePath: null,
      worktreeStatus: null,
      threadId: null,
      threadTitle: null,
      threadStatus: null,
    })).toBeNull();
  });

  it("round-trips through localStorage", () => {
    const snapshot = buildStartupShellSnapshot({
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
    });

    saveStartupShellSnapshot(snapshot);

    expect(loadStartupShellSnapshot()).toEqual(snapshot);
  });

  it("round-trips persisted repository shell lists and panel state", () => {
    const snapshot = buildStartupShellSnapshot({
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo-one",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
      repositories: [
        {
          id: "repo-1",
          name: "Repo One",
          rootPath: "/tmp/repo-one",
          defaultBranch: "main",
          worktrees: [
            {
              id: "wt-1",
              repositoryId: "repo-1",
              branch: "main",
              path: "/tmp/repo-one",
              baseBranch: "main",
              status: "active",
              branchRenamed: false,
            },
          ],
        },
        {
          id: "repo-2",
          name: "Repo Two",
          rootPath: "/tmp/repo-two",
          defaultBranch: "develop",
          worktrees: [
            {
              id: "wt-2",
              repositoryId: "repo-2",
              branch: "feat/shell",
              path: "/tmp/repo-two",
              baseBranch: "develop",
              status: "active",
              branchRenamed: true,
            },
          ],
        },
      ],
      hiddenRepositoryIds: ["repo-2"],
      expandedRepositoryIds: ["repo-1", "repo-2"],
    });

    saveStartupShellSnapshot(snapshot);

    expect(loadStartupShellSnapshot()).toEqual(snapshot);
  });

  it("migrates the legacy raw snapshot payload into TanStack localStorage format", () => {
    window.localStorage.setItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY, JSON.stringify({
      version: 1,
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
    }));

    const snapshot = primeStartupShellSnapshot();
    const raw = window.localStorage.getItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY);

    expect(snapshot).toEqual(readPersistedStartupShellSnapshot());
    expect(raw).toContain("\"s:workspace-shell\"");
    expect(raw).toContain("\"versionKey\"");
  });

  it("primes localStorage from persisted workspace shell fallback when fast snapshot is missing", () => {
    const snapshot = buildStartupShellSnapshot({
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
    });

    expect(primeStartupShellSnapshot({
      readFallbackSnapshot: () => snapshot,
    })).toEqual(snapshot);
    expect(loadStartupShellSnapshot()).toEqual(snapshot);
  });

  it("prefers an injected startup shell snapshot override", () => {
    window.__CS_STARTUP_SHELL_SNAPSHOT_OVERRIDE__ = JSON.stringify({
      version: 1,
      capturedAt: "2026-05-20T07:00:00.000Z",
      repoId: "repo-override",
      repoName: "Override Repo",
      worktreeId: "wt-override",
      worktreeBranch: "main",
      worktreePath: "/tmp/override",
      worktreeStatus: "active",
      threadId: "thread-override",
      threadTitle: "Injected shell",
      threadStatus: "idle",
    });

    expect(loadStartupShellSnapshot()).toEqual({
      version: 1,
      capturedAt: "2026-05-20T07:00:00.000Z",
      repoId: "repo-override",
      repoName: "Override Repo",
      worktreeId: "wt-override",
      worktreeBranch: "main",
      worktreePath: "/tmp/override",
      worktreeStatus: "active",
      threadId: "thread-override",
      threadTitle: "Injected shell",
      threadStatus: "idle",
    });
  });

  it("skips stored and fallback snapshots when desktop startup explicitly disables them", () => {
    const snapshot = buildStartupShellSnapshot({
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
    });

    saveStartupShellSnapshot(snapshot);
    window.__CS_STARTUP_IGNORE_STORED_SNAPSHOT__ = true;

    expect(loadStartupShellSnapshot()).toBeNull();
    expect(primeStartupShellSnapshot({
      readFallbackSnapshot: () => snapshot,
    })).toBeNull();
    expect(window.localStorage.getItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY)).toBeNull();
  });

  it("ignores invalid persisted fallback snapshot versions during priming", () => {
    const invalidSnapshot = {
      version: 2,
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
    } as unknown as ReturnType<typeof buildStartupShellSnapshot>;

    expect(primeStartupShellSnapshot({
      readFallbackSnapshot: () => invalidSnapshot,
    })).toBeNull();
    expect(loadStartupShellSnapshot()).toBeNull();
  });

  it("rejects invalid persisted payloads", () => {
    window.localStorage.setItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY, JSON.stringify({
      version: 2,
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
    }));

    expect(loadStartupShellSnapshot()).toBeNull();
  });

  it("restores selection ids from snapshot only when search params are absent", () => {
    const snapshot = buildStartupShellSnapshot({
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
    });

    expect(resolveStartupWorkspaceSelection({
      snapshot,
    })).toEqual({
      repoId: "repo-1",
      worktreeId: "wt-1",
      threadId: "thread-1",
    });

    expect(resolveStartupWorkspaceSelection({
      repoId: "repo-2",
      worktreeId: "wt-2",
      threadId: "thread-2",
      snapshot,
    })).toEqual({
      repoId: "repo-2",
      worktreeId: "wt-2",
      threadId: "thread-2",
    });
  });

  it("keeps fallback shell labels until live selection metadata finishes loading", () => {
    const snapshot = buildStartupShellSnapshot({
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
    });

    expect(resolveStartupShellFallbackState({
      snapshot,
      desiredRepoId: "repo-1",
      desiredWorktreeId: "wt-1",
      desiredThreadId: "thread-1",
      liveRepoId: "repo-1",
      liveRepoName: null,
      liveWorktreeId: "wt-1",
      liveWorktreeBranch: null,
      liveWorktreePath: null,
      liveThreadId: "thread-1",
      liveThreadTitle: null,
    })).toEqual({
      snapshot,
      repoFallbackActive: true,
      worktreeFallbackActive: true,
      threadFallbackActive: true,
    });
  });

  it("drops fallback shell labels after live metadata catches up", () => {
    const snapshot = buildStartupShellSnapshot({
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
    });

    expect(resolveStartupShellFallbackState({
      snapshot,
      desiredRepoId: "repo-1",
      desiredWorktreeId: "wt-1",
      desiredThreadId: "thread-1",
      liveRepoId: "repo-1",
      liveRepoName: "Repo One",
      liveWorktreeId: "wt-1",
      liveWorktreeBranch: "main",
      liveWorktreePath: "/tmp/repo",
      liveThreadId: "thread-1",
      liveThreadTitle: "Fix startup",
    })).toEqual({
      snapshot: null,
      repoFallbackActive: false,
      worktreeFallbackActive: false,
      threadFallbackActive: false,
    });
  });

  it("preserves fallback shell fields while matching live state is still incomplete", () => {
    const snapshot = buildStartupShellSnapshot({
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
    });

    expect(mergeStartupShellSnapshotInputFromFallback({
      liveInput: {
        repoId: null,
        repoName: null,
        worktreeId: "wt-1",
        worktreeBranch: null,
        worktreePath: null,
        worktreeStatus: null,
        threadId: null,
        threadTitle: null,
        threadStatus: null,
      },
      fallbackSnapshot: snapshot,
      preserveRepoFallback: true,
      preserveWorktreeFallback: true,
      preserveThreadFallback: true,
    })).toEqual({
      capturedAt: undefined,
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
    });
  });

  it("allows thread fallback data to clear once preservation is disabled", () => {
    const snapshot = buildStartupShellSnapshot({
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
    });

    expect(mergeStartupShellSnapshotInputFromFallback({
      liveInput: {
        repoId: "repo-1",
        repoName: null,
        worktreeId: "wt-1",
        worktreeBranch: null,
        worktreePath: null,
        worktreeStatus: null,
        threadId: null,
        threadTitle: null,
        threadStatus: null,
      },
      fallbackSnapshot: snapshot,
      preserveRepoFallback: true,
      preserveWorktreeFallback: true,
      preserveThreadFallback: false,
    })).toEqual({
      capturedAt: undefined,
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: null,
      threadTitle: null,
      threadStatus: null,
    });
  });
});
