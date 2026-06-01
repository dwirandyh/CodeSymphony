import type { ChatThread, Repository, WorkspaceStartupBootstrapData } from "@codesymphony/shared-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getWorkspaceBootstrapMock = vi.fn();

vi.mock("./api", () => ({
  api: {
    getWorkspaceBootstrap: (...args: unknown[]) => getWorkspaceBootstrapMock(...args),
  },
}));

function createBootstrapData(overrides?: Partial<WorkspaceStartupBootstrapData>): WorkspaceStartupBootstrapData {
  const repository: Repository = {
    id: "repo-1",
    name: "Repo",
    rootPath: "/repo",
    defaultBranch: "main",
    setupScript: null,
    teardownScript: null,
    runScript: null,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    worktrees: [{
      id: "wt-1",
      repositoryId: "repo-1",
      branch: "main",
      path: "/repo",
      baseBranch: "main",
      status: "active",
      branchRenamed: false,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
    }],
  };

  return {
    selection: {
      repositoryId: "repo-1",
      worktreeId: "wt-1",
      threadId: "thread-2",
    },
    repositories: [repository],
    repository,
    worktree: {
      id: "wt-1",
      repositoryId: "repo-1",
      branch: "main",
      path: "/repo",
      baseBranch: "main",
      status: "active",
      branchRenamed: false,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
    },
    threads: [{
      id: "thread-1",
      worktreeId: "wt-1",
      title: "Older",
      kind: "default",
      permissionProfile: "default",
      permissionMode: "default",
      mode: "default",
      titleEditedManually: false,
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      opencodeSessionId: null,
      active: false,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
      isAutomation: false,
    }],
    threadsLoaded: true,
    thread: {
      id: "thread-2",
      worktreeId: "wt-1",
      title: "Selected",
      kind: "default",
      permissionProfile: "default",
      permissionMode: "default",
      mode: "default",
      titleEditedManually: false,
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      opencodeSessionId: null,
      active: true,
      createdAt: "2026-05-20T00:00:01.000Z",
      updatedAt: "2026-05-20T00:00:01.000Z",
      isAutomation: false,
    },
    gitStatus: {
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      entries: [],
    },
    capturedAt: "2026-05-20T00:00:02.000Z",
    ...overrides,
  };
}

describe("workspaceStartupBootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    getWorkspaceBootstrapMock.mockReset();
  });

  it("resolves requested selection from search first, then snapshot", async () => {
    const { resolveWorkspaceStartupBootstrapSelection } = await import("./workspaceStartupBootstrap");

    expect(resolveWorkspaceStartupBootstrapSelection({
      search: "?worktreeId=wt-2",
      snapshot: {
        version: 1,
        capturedAt: "2026-05-20T00:00:00.000Z",
        repoId: "repo-1",
        repoName: "Repo",
        worktreeId: "wt-1",
        worktreeBranch: "main",
        worktreePath: "/repo",
        worktreeStatus: "active",
        threadId: "thread-1",
        threadTitle: "Thread",
        threadStatus: "idle",
      },
    })).toEqual({
      repositoryId: "repo-1",
      worktreeId: "wt-2",
      threadId: undefined,
    });
  });

  it("resolves desktop startup bootstrap selection from a persisted shell snapshot when search is empty", async () => {
    const { resolveWorkspaceStartupBootstrapSelection } = await import("./workspaceStartupBootstrap");

    expect(resolveWorkspaceStartupBootstrapSelection({
      search: "",
      snapshot: {
        version: 1,
        capturedAt: "2026-06-01T08:15:00.000Z",
        repoId: "cmnr1vc3l0004m9yo94fp28om",
        repoName: "winkatsu-backend",
        worktreeId: "cmpuffnnx000fm9jja3717nmi",
        worktreeBranch: "feat/school-lesson-last-played-map",
        worktreePath: "/repo",
        worktreeStatus: "active",
        threadId: "cmpuleont000xm9j2t6hk90xm",
        threadTitle: "Last Played Chapter Selection",
        threadStatus: "idle",
      },
    })).toEqual({
      repositoryId: "cmnr1vc3l0004m9yo94fp28om",
      worktreeId: "cmpuffnnx000fm9jja3717nmi",
      threadId: "cmpuleont000xm9j2t6hk90xm",
    });
  });

  it("hydrates repository, selected worktree threads, and git status from bootstrap payload", async () => {
    const { applyWorkspaceStartupBootstrap } = await import("./workspaceStartupBootstrap");
    const queryClient = {
      setQueryData: vi.fn(),
    };
    const payload = createBootstrapData();

    applyWorkspaceStartupBootstrap(queryClient as never, payload);

    expect(queryClient.setQueryData).toHaveBeenCalledTimes(3);
    expect(queryClient.setQueryData).toHaveBeenNthCalledWith(
      1,
      ["repositories"],
      expect.any(Function),
    );
    expect(queryClient.setQueryData).toHaveBeenNthCalledWith(
      2,
      ["threads", "list", "wt-1"],
      expect.arrayContaining([
        expect.objectContaining({ id: "thread-1" }),
        expect.objectContaining({ id: "thread-2" }),
      ]),
    );
    expect(queryClient.setQueryData).toHaveBeenNthCalledWith(
      3,
      ["worktrees", "wt-1", "gitStatus"],
      [expect.objectContaining({ worktreeId: "wt-1" })],
    );
  });

  it("hydrates the full repository list when bootstrap includes multiple repositories", async () => {
    const { applyWorkspaceStartupBootstrap } = await import("./workspaceStartupBootstrap");
    const queryClient = {
      setQueryData: vi.fn(),
    };

    applyWorkspaceStartupBootstrap(queryClient as never, createBootstrapData({
      repositories: [
        createBootstrapData().repository!,
        {
          id: "repo-2",
          name: "Repo 2",
          rootPath: "/repo-2",
          defaultBranch: "main",
          setupScript: null,
          teardownScript: null,
          runScript: null,
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:01.000Z",
          worktrees: [{
            id: "wt-2",
            repositoryId: "repo-2",
            branch: "main",
            path: "/repo-2",
            baseBranch: "main",
            status: "active",
            branchRenamed: false,
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:01.000Z",
          }],
        },
      ],
    }));

    const repositoriesUpdater = queryClient.setQueryData.mock.calls[0]?.[1];
    expect(typeof repositoriesUpdater).toBe("function");
    expect(repositoriesUpdater([])).toEqual([
      expect.objectContaining({ id: "repo-2" }),
      expect.objectContaining({ id: "repo-1" }),
    ]);
  });

  it("writes empty thread cache when bootstrap confirms no selected worktree threads", async () => {
    const { applyWorkspaceStartupBootstrap } = await import("./workspaceStartupBootstrap");
    const queryClient = {
      setQueryData: vi.fn(),
    };

    applyWorkspaceStartupBootstrap(queryClient as never, createBootstrapData({
      selection: {
        repositoryId: "repo-1",
        worktreeId: "wt-1",
        threadId: null,
      },
      threads: [],
      threadsLoaded: true,
      thread: null,
      gitStatus: null,
    }));

    expect(queryClient.setQueryData).toHaveBeenCalledWith(
      ["threads", "list", "wt-1"],
      [],
    );
  });

  it("starts bootstrap fetch only when startup selection exists", async () => {
    getWorkspaceBootstrapMock.mockResolvedValue(createBootstrapData());
    const { startWorkspaceStartupBootstrap } = await import("./workspaceStartupBootstrap");
    const queryClient = {
      setQueryData: vi.fn(),
    };

    const skipped = await startWorkspaceStartupBootstrap(queryClient as never, {
      selection: {
        repositoryId: undefined,
        worktreeId: undefined,
        threadId: undefined,
      },
    });

    expect(skipped).toBeNull();
    expect(getWorkspaceBootstrapMock).not.toHaveBeenCalled();

    const result = await startWorkspaceStartupBootstrap(queryClient as never, {
      selection: {
        repositoryId: "repo-1",
        worktreeId: "wt-1",
        threadId: "thread-2",
      },
    });

    expect(getWorkspaceBootstrapMock).toHaveBeenCalledWith({
      repositoryId: "repo-1",
      worktreeId: "wt-1",
      threadId: "thread-2",
    });
    expect(result).toEqual(createBootstrapData());
  });
});
