import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("workspaceShellState", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("writes, reads, updates, and clears last known workspace shell snapshot", async () => {
    vi.doMock("../lib/workspacePersistence", async () => {
      const { localOnlyCollectionOptions } = await import("@tanstack/db");

      return {
        withWorkspaceCollectionPersistence: (options: { id?: string; getKey: (row: { id: string }) => string }) => (
          localOnlyCollectionOptions({
            ...options,
            initialData: [],
          })
        ),
      };
    });

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

    writeWorkspaceShellStateSnapshot(null);
    expect(readWorkspaceShellStateSnapshot()).toBeNull();

    await resetWorkspaceShellStateCollectionForTest();
  });

  it("drops invalid persisted workspace shell rows when schema version mismatches", async () => {
    vi.doMock("../lib/workspacePersistence", async () => {
      const { localOnlyCollectionOptions } = await import("@tanstack/db");

      return {
        withWorkspaceCollectionPersistence: (options: { id?: string; getKey: (row: { id: string }) => string }) => (
          localOnlyCollectionOptions({
            ...options,
            initialData: [],
          })
        ),
      };
    });

    const {
      getWorkspaceShellStateCollection,
      readWorkspaceShellStateSnapshot,
      resetWorkspaceShellStateCollectionForTest,
    } = await import("./workspaceShellState");

    const collection = getWorkspaceShellStateCollection();
    collection.insert({
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
    } as never);

    expect(readWorkspaceShellStateSnapshot()).toBeNull();
    expect(collection.toArray).toEqual([]);

    await resetWorkspaceShellStateCollectionForTest();
  });
});
