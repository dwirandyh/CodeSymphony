import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerChatRoutes, parseStreamStartCursor, formatSseEvent } from "../src/routes/chats";

describe("parseStreamStartCursor", () => {
  it("returns undefined when both inputs are null/undefined", () => {
    expect(parseStreamStartCursor(undefined, undefined)).toBeUndefined();
  });

  it("returns afterIdx when only afterIdx provided", () => {
    expect(parseStreamStartCursor("5", undefined)).toBe(5);
  });

  it("returns lastEventId when only lastEventId provided", () => {
    expect(parseStreamStartCursor(undefined, "10")).toBe(10);
  });

  it("returns max of both when both provided", () => {
    expect(parseStreamStartCursor("3", "7")).toBe(7);
    expect(parseStreamStartCursor("10", "5")).toBe(10);
  });

  it("handles array input (takes last)", () => {
    expect(parseStreamStartCursor(["5", "10"], undefined)).toBe(10);
  });

  it("returns undefined for non-numeric input", () => {
    expect(parseStreamStartCursor("abc", undefined)).toBeUndefined();
  });

  it("returns 0 for zero input", () => {
    expect(parseStreamStartCursor("0", undefined)).toBe(0);
  });
});

describe("formatSseEvent", () => {
  it("formats an event as SSE string", () => {
    const event = { idx: 5, type: "text.delta", payload: { text: "hi" } } as any;
    const result = formatSseEvent(event);
    expect(result).toContain("id: 5");
    expect(result).toContain("event: text.delta");
    expect(result).toContain("data: ");
    expect(result).toContain('"text":"hi"');
  });
});

describe("chat routes", () => {
  let app: FastifyInstance;

  const mockChatService = {
    listThreads: vi.fn(),
    createThread: vi.fn(),
    deleteThread: vi.fn(),
    getThreadById: vi.fn(),
    renameThreadTitle: vi.fn(),
    sendMessage: vi.fn(),
    resolvePermission: vi.fn(),
    answerQuestion: vi.fn(),
    dismissQuestion: vi.fn(),
    approvePlan: vi.fn(),
    revisePlan: vi.fn(),
    stopRun: vi.fn(),
    listMessagesPage: vi.fn(),
    listEventsPage: vi.fn(),
    listThreadSnapshot: vi.fn(),
    listEvents: vi.fn(),
  };

  const mockEventHub = {
    list: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  };

  const mockRepositoryService = {
    getById: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify({ logger: false });
    app.decorate("chatService", mockChatService as never);
    app.decorate("eventHub", mockEventHub as never);
    app.decorate("repositoryService", mockRepositoryService as never);
    await app.register(registerChatRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /api/worktrees/:id/threads", () => {
    it("lists threads for a worktree", async () => {
      mockChatService.listThreads.mockResolvedValue([{ id: "t1", title: "Test" }]);
      const res = await app.inject({ method: "GET", url: "/api/worktrees/w1/threads" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(1);
    });

    it("returns 400 on error", async () => {
      mockChatService.listThreads.mockRejectedValue(new Error("fail"));
      const res = await app.inject({ method: "GET", url: "/api/worktrees/w1/threads" });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/worktrees/:id/threads", () => {
    it("creates a new thread (201)", async () => {
      mockChatService.createThread.mockResolvedValue({ id: "t-new", title: "New" });
      const res = await app.inject({ method: "POST", url: "/api/worktrees/w1/threads", payload: {} });
      expect(res.statusCode).toBe(201);
    });

    it("returns 400 on error", async () => {
      mockChatService.createThread.mockRejectedValue(new Error("fail"));
      const res = await app.inject({ method: "POST", url: "/api/worktrees/w1/threads", payload: {} });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/threads/:id", () => {
    it("returns thread data", async () => {
      mockChatService.getThreadById.mockResolvedValue({ id: "t1", title: "Test" });
      const res = await app.inject({ method: "GET", url: "/api/threads/t1" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.id).toBe("t1");
    });

    it("returns 404 when not found", async () => {
      mockChatService.getThreadById.mockResolvedValue(null);
      const res = await app.inject({ method: "GET", url: "/api/threads/xxx" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("PATCH /api/threads/:id/title", () => {
    it("renames thread title", async () => {
      mockChatService.renameThreadTitle.mockResolvedValue({ id: "t1", title: "New" });
      const res = await app.inject({
        method: "PATCH",
        url: "/api/threads/t1/title",
        payload: { title: "New" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("returns 400 on error", async () => {
      mockChatService.renameThreadTitle.mockRejectedValue(new Error("bad"));
      const res = await app.inject({
        method: "PATCH",
        url: "/api/threads/t1/title",
        payload: { title: "" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("DELETE /api/threads/:id", () => {
    it("deletes a thread (204)", async () => {
      mockChatService.deleteThread.mockResolvedValue(undefined);
      const res = await app.inject({ method: "DELETE", url: "/api/threads/t1" });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("POST /api/threads/:id/messages", () => {
    it("sends a message (201)", async () => {
      mockChatService.sendMessage.mockResolvedValue({ id: "m1" });
      const res = await app.inject({
        method: "POST",
        url: "/api/threads/t1/messages",
        payload: { content: "Hello" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("returns 400 on error", async () => {
      mockChatService.sendMessage.mockRejectedValue(new Error("fail"));
      const res = await app.inject({
        method: "POST",
        url: "/api/threads/t1/messages",
        payload: { content: "Hello" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/threads/:id/stop", () => {
    it("stops a run (204)", async () => {
      mockChatService.stopRun.mockResolvedValue(undefined);
      const res = await app.inject({ method: "POST", url: "/api/threads/t1/stop" });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("POST /api/threads/:id/permissions/resolve", () => {
    it("resolves a permission (204)", async () => {
      mockChatService.resolvePermission.mockResolvedValue(undefined);
      const res = await app.inject({
        method: "POST",
        url: "/api/threads/t1/permissions/resolve",
        payload: { requestId: "req-1", decision: "allow" },
      });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("POST /api/threads/:id/questions/answer", () => {
    it("answers a question (204)", async () => {
      mockChatService.answerQuestion.mockResolvedValue(undefined);
      const res = await app.inject({
        method: "POST",
        url: "/api/threads/t1/questions/answer",
        payload: { requestId: "q-1", answers: { "0": "A" } },
      });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("POST /api/threads/:id/questions/dismiss", () => {
    it("dismisses a question (204)", async () => {
      mockChatService.dismissQuestion.mockResolvedValue(undefined);
      const res = await app.inject({
        method: "POST",
        url: "/api/threads/t1/questions/dismiss",
        payload: { requestId: "q-1" },
      });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("POST /api/threads/:id/plan/approve", () => {
    it("approves a plan (204)", async () => {
      mockChatService.approvePlan.mockResolvedValue(undefined);
      const res = await app.inject({ method: "POST", url: "/api/threads/t1/plan/approve" });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("POST /api/threads/:id/plan/revise", () => {
    it("revises a plan (204)", async () => {
      mockChatService.revisePlan.mockResolvedValue(undefined);
      const res = await app.inject({
        method: "POST",
        url: "/api/threads/t1/plan/revise",
        payload: { feedback: "Change approach" },
      });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("GET /api/threads/:id/messages (paginated)", () => {
    it("returns paginated messages", async () => {
      mockChatService.listMessagesPage.mockResolvedValue({
        data: [],
        pageInfo: { hasMore: false },
      });
      const res = await app.inject({ method: "GET", url: "/api/threads/t1/messages" });
      expect(res.statusCode).toBe(200);
    });

    it("passes limit and beforeSeq", async () => {
      mockChatService.listMessagesPage.mockResolvedValue({
        data: [],
        pageInfo: { hasMore: false },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/threads/t1/messages?limit=10&beforeSeq=50",
      });
      expect(res.statusCode).toBe(200);
    });

    it("returns 400 for invalid beforeSeq", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/threads/t1/messages?beforeSeq=abc",
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for invalid limit", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/threads/t1/messages?limit=-1",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/threads/:id/events (paginated)", () => {
    it("returns paginated events", async () => {
      mockChatService.listEventsPage.mockResolvedValue({
        data: [],
        pageInfo: { hasMore: false },
      });
      const res = await app.inject({ method: "GET", url: "/api/threads/t1/events" });
      expect(res.statusCode).toBe(200);
    });

    it("returns 400 for invalid beforeIdx", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/threads/t1/events?beforeIdx=abc",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/threads/:id/snapshot", () => {
    it("returns thread snapshot", async () => {
      mockChatService.listThreadSnapshot.mockResolvedValue({
        thread: { id: "t1" },
        messages: [],
        events: [],
      });
      const res = await app.inject({ method: "GET", url: "/api/threads/t1/snapshot" });
      expect(res.statusCode).toBe(200);
    });

    it("returns 400 for invalid messageLimit", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/threads/t1/snapshot?messageLimit=abc",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/repositories/:id/threads", () => {
    it("creates thread for repository worktree (201)", async () => {
      mockRepositoryService.getById.mockResolvedValue({
        id: "r1",
        rootPath: "/home/repo",
        worktrees: [{ id: "wt-1", path: "/home/repo", status: "active", branch: "main" }],
      });
      mockChatService.createThread.mockResolvedValue({ id: "t-new" });
      const res = await app.inject({ method: "POST", url: "/api/repositories/r1/threads", payload: {} });
      expect(res.statusCode).toBe(201);
    });

    it("returns 404 when repository not found", async () => {
      mockRepositoryService.getById.mockResolvedValue(null);
      const res = await app.inject({ method: "POST", url: "/api/repositories/xxx/threads", payload: {} });
      expect(res.statusCode).toBe(404);
    });

    it("returns 400 when no worktrees available", async () => {
      mockRepositoryService.getById.mockResolvedValue({
        id: "r1",
        rootPath: "/home/repo",
        worktrees: [],
      });
      const res = await app.inject({ method: "POST", url: "/api/repositories/r1/threads", payload: {} });
      expect(res.statusCode).toBe(400);
    });
  });
});
