import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerChatRoutes } from "../src/routes/chats";

describe("PATCH /api/threads/:id/title", () => {
  let app: FastifyInstance;
  const chatRenameThreadTitle = vi.fn();

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.decorate("repositoryService", {
      getById: vi.fn(),
    } as never);
    app.decorate("chatService", {
      listThreads: vi.fn(),
      createThread: vi.fn(),
      getThreadById: vi.fn(),
      renameThreadTitle: chatRenameThreadTitle,
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

  it("renames thread title and returns updated thread", async () => {
    chatRenameThreadTitle.mockResolvedValueOnce({
      id: "thread-1",
      worktreeId: "wt-1",
      title: "Investigate SSE reconnect",
      kind: "default",
      permissionProfile: "default",
      titleEditedManually: true,
      claudeSessionId: null,
      active: false,
      createdAt: "2026-02-28T00:00:00.000Z",
      updatedAt: "2026-02-28T00:00:00.000Z",
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/threads/thread-1/title",
      payload: { title: "Investigate SSE reconnect" },
    });

    expect(response.statusCode).toBe(200);
    expect(chatRenameThreadTitle).toHaveBeenCalledWith("thread-1", { title: "Investigate SSE reconnect" });
    expect(response.json()).toMatchObject({
      data: {
        id: "thread-1",
        title: "Investigate SSE reconnect",
        titleEditedManually: true,
      },
    });
  });

  it("returns 400 when rename fails", async () => {
    chatRenameThreadTitle.mockRejectedValueOnce(new Error("Chat thread not found"));

    const response = await app.inject({
      method: "PATCH",
      url: "/api/threads/thread-unknown/title",
      payload: { title: "Anything" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Chat thread not found" });
  });
});
