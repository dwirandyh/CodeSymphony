import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCachedWorktreeGitStatusMock = vi.fn();

vi.mock("../src/services/worktreeGitQueryCache", () => ({
  getCachedWorktreeGitStatus: (...args: unknown[]) => getCachedWorktreeGitStatusMock(...args),
}));

import { registerWorkspaceBootstrapRoutes } from "../src/routes/workspaceBootstrap";

describe("workspace bootstrap routes", () => {
  let app: FastifyInstance;

  const repositoryGetById = vi.fn();
  const repositoryList = vi.fn();
  const worktreeGetById = vi.fn();
  const chatGetThreadById = vi.fn();
  const chatListThreads = vi.fn();

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.decorate("repositoryService", {
      getById: repositoryGetById,
      list: repositoryList,
    } as never);
    app.decorate("worktreeService", {
      getById: worktreeGetById,
    } as never);
    app.decorate("chatService", {
      getThreadById: chatGetThreadById,
      listThreads: chatListThreads,
    } as never);

    await app.register(registerWorkspaceBootstrapRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("returns compact bootstrap shell data for selected repository, worktree, and thread", async () => {
    repositoryList.mockResolvedValueOnce([{
      id: "repo-1",
      name: "CodeSymphony",
      rootPath: "/repo",
      defaultBranch: "main",
      setupScript: null,
      teardownScript: null,
      runScript: null,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
      worktrees: [],
    }]);
    repositoryGetById.mockResolvedValueOnce({
      id: "repo-1",
      name: "CodeSymphony",
      rootPath: "/repo",
      defaultBranch: "main",
      setupScript: null,
      teardownScript: null,
      runScript: null,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
      worktrees: [],
    });
    worktreeGetById.mockResolvedValueOnce({
      id: "wt-1",
      repositoryId: "repo-1",
      branch: "main",
      path: "/repo",
      baseBranch: "main",
      status: "active",
      lastCreateError: null,
      lastDeleteError: null,
      branchRenamed: false,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
    });
    chatGetThreadById.mockResolvedValueOnce({
      id: "thread-1",
      worktreeId: "wt-1",
      title: "Instant open",
      kind: "default",
      isAutomation: false,
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
    });
    chatListThreads.mockResolvedValueOnce([
      {
        id: "thread-1",
        worktreeId: "wt-1",
        title: "Instant open",
        kind: "default",
        isAutomation: false,
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
      },
    ]);
    getCachedWorktreeGitStatusMock.mockResolvedValueOnce({
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      entries: [],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap?repositoryId=repo-1&worktreeId=wt-1&threadId=thread-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        selection: {
          repositoryId: "repo-1",
          worktreeId: "wt-1",
          threadId: "thread-1",
        },
        repositories: [
          expect.objectContaining({
            id: "repo-1",
            name: "CodeSymphony",
          }),
        ],
        repository: expect.objectContaining({
          id: "repo-1",
          name: "CodeSymphony",
        }),
        worktree: expect.objectContaining({
          id: "wt-1",
          repositoryId: "repo-1",
        }),
        threads: [
          expect.objectContaining({
            id: "thread-1",
            title: "Instant open",
          }),
        ],
        threadsLoaded: true,
        thread: expect.objectContaining({
          id: "thread-1",
          title: "Instant open",
        }),
        gitStatus: {
          branch: "main",
          upstream: "origin/main",
          ahead: 0,
          behind: 0,
          entries: [],
        },
        capturedAt: expect.any(String),
      },
    });
  });

  it("returns a partial bootstrap payload when requested ids are stale or missing", async () => {
    repositoryList.mockResolvedValueOnce([]);
    repositoryGetById.mockResolvedValueOnce(null);
    worktreeGetById.mockResolvedValueOnce(null);
    chatGetThreadById.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap?repositoryId=repo-missing&worktreeId=wt-missing&threadId=thread-missing",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        selection: {
          repositoryId: null,
          worktreeId: null,
          threadId: null,
        },
        repositories: [],
        repository: null,
        worktree: null,
        threads: [],
        threadsLoaded: false,
        thread: null,
        gitStatus: null,
        capturedAt: expect.any(String),
      },
    });
    expect(chatListThreads).not.toHaveBeenCalled();
    expect(getCachedWorktreeGitStatusMock).not.toHaveBeenCalled();
  });

  it("selects the backend-preferred thread when bootstrapping a worktree without a thread id", async () => {
    repositoryList.mockResolvedValueOnce([]);
    repositoryGetById.mockResolvedValueOnce({
      id: "repo-1",
      name: "CodeSymphony",
      rootPath: "/repo",
      defaultBranch: "main",
      setupScript: null,
      teardownScript: null,
      runScript: null,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
      worktrees: [],
    });
    worktreeGetById.mockResolvedValueOnce({
      id: "wt-1",
      repositoryId: "repo-1",
      branch: "main",
      path: "/repo",
      baseBranch: "main",
      status: "active",
      lastCreateError: null,
      lastDeleteError: null,
      branchRenamed: false,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
    });
    chatListThreads.mockResolvedValueOnce([
      {
        id: "thread-old",
        worktreeId: "wt-1",
        title: "Old",
        kind: "default",
        isAutomation: false,
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
      },
      {
        id: "thread-preferred",
        worktreeId: "wt-1",
        title: "Preferred",
        kind: "default",
        isAutomation: false,
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
        preferred: true,
        createdAt: "2026-05-20T00:00:01.000Z",
        updatedAt: "2026-05-20T00:00:01.000Z",
      },
    ]);
    getCachedWorktreeGitStatusMock.mockResolvedValueOnce({
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      entries: [],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap?repositoryId=repo-1&worktreeId=wt-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.selection.threadId).toBe("thread-preferred");
    expect(response.json().data.thread).toMatchObject({
      id: "thread-preferred",
      title: "Preferred",
    });
  });

  it("marks thread bootstrap as unresolved when listing threads fails", async () => {
    repositoryList.mockResolvedValueOnce([{
      id: "repo-1",
      name: "CodeSymphony",
      rootPath: "/repo",
      defaultBranch: "main",
      setupScript: null,
      teardownScript: null,
      runScript: null,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
      worktrees: [],
    }]);
    repositoryGetById.mockResolvedValueOnce({
      id: "repo-1",
      name: "CodeSymphony",
      rootPath: "/repo",
      defaultBranch: "main",
      setupScript: null,
      teardownScript: null,
      runScript: null,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
      worktrees: [],
    });
    worktreeGetById.mockResolvedValueOnce({
      id: "wt-1",
      repositoryId: "repo-1",
      branch: "main",
      path: "/repo",
      baseBranch: "main",
      status: "active",
      lastCreateError: null,
      lastDeleteError: null,
      branchRenamed: false,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
    });
    chatGetThreadById.mockResolvedValueOnce(null);
    chatListThreads.mockRejectedValueOnce(new Error("sqlite busy"));
    getCachedWorktreeGitStatusMock.mockResolvedValueOnce({
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      entries: [],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/workspace/bootstrap?repositoryId=repo-1&worktreeId=wt-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        selection: {
          repositoryId: "repo-1",
          worktreeId: "wt-1",
          threadId: null,
        },
        repositories: [
          expect.objectContaining({ id: "repo-1" }),
        ],
        repository: expect.objectContaining({ id: "repo-1" }),
        worktree: expect.objectContaining({ id: "wt-1" }),
        threads: [],
        threadsLoaded: false,
        thread: null,
        gitStatus: {
          branch: "main",
          upstream: "origin/main",
          ahead: 0,
          behind: 0,
          entries: [],
        },
        capturedAt: expect.any(String),
      },
    });
  });
});
