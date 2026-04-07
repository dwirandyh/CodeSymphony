import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerChatRoutes } from "../src/routes/chats";

describe("POST /api/repositories/:id/threads", () => {
  let app: FastifyInstance;
  const repositoryGetById = vi.fn();
  const chatCreateThread = vi.fn();

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.decorate("repositoryService", {
      getById: repositoryGetById,
    } as never);
    app.decorate("chatService", {
      listThreads: vi.fn(),
      createThread: chatCreateThread,
      getThreadById: vi.fn(),
      deleteThread: vi.fn(),
      listMessages: vi.fn(),
      sendMessage: vi.fn(),
      stopRun: vi.fn(),
      answerQuestion: vi.fn(),
      approvePlan: vi.fn(),
      revisePlan: vi.fn(),
      resolvePermission: vi.fn(),
      listEvents: vi.fn(),
    } as never);
    app.decorate("eventHub", {
      subscribe: vi.fn(() => () => undefined),
    } as never);

    await app.register(registerChatRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("returns 404 when repository is missing", async () => {
    repositoryGetById.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: "POST",
      url: "/api/repositories/repo-unknown/threads",
      payload: { title: "New Thread" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Repository not found" });
    expect(chatCreateThread).not.toHaveBeenCalled();
  });

  it("creates the thread in the root worktree when available", async () => {
    repositoryGetById.mockResolvedValueOnce({
      id: "repo-1",
      rootPath: "/Users/test/project",
      worktrees: [
        { id: "wt-root", status: "active", path: "/Users/test/project", branch: "main" },
        { id: "wt-feature", status: "active", path: "/Users/test/.codesymphony/worktrees/feature", branch: "feature/a" },
      ],
    });
    chatCreateThread.mockResolvedValueOnce({
      id: "thread-1",
      worktreeId: "wt-root",
      title: "New Thread",
      kind: "default",
      permissionProfile: "default",
      permissionMode: "default",
      mode: "default",
      claudeSessionId: null,
      active: false,
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:00.000Z",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/repositories/repo-1/threads",
      payload: { title: "New Thread" },
    });

    expect(response.statusCode).toBe(201);
    expect(chatCreateThread).toHaveBeenCalledWith("wt-root", { title: "New Thread" });
  });

  it("returns 400 when no active root worktree exists", async () => {
    repositoryGetById.mockResolvedValueOnce({
      id: "repo-1",
      rootPath: "/Users/test/project",
      worktrees: [
        { id: "wt-archived-root", status: "archived", path: "/Users/test/project", branch: "main" },
        { id: "wt-feature", status: "active", path: "/Users/test/.codesymphony/worktrees/feature", branch: "feature/a" },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/repositories/repo-1/threads",
      payload: { title: "New Thread" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Repository root worktree is not available" });
    expect(chatCreateThread).not.toHaveBeenCalled();
  });
});
