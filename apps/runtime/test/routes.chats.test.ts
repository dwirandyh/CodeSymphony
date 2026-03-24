import Fastify, { type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import {
  createChatService,
  ChatThreadActiveConflictError,
  ChatThreadNotFoundError,
} from "../src/services/chat";
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

const TEST_DATABASE_URL =
  process.env.DATABASE_URL && process.env.DATABASE_URL.includes("test.db")
    ? process.env.DATABASE_URL
    : "file:./prisma/test.db";

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: TEST_DATABASE_URL,
    },
  },
});

async function resetDatabase(): Promise<void> {
  await prisma.chatEvent.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.chatThread.deleteMany();
  await prisma.worktree.deleteMany();
  await prisma.repository.deleteMany();
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

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
    listMessages: vi.fn(),
    listEvents: vi.fn(),
    listThreadSnapshot: vi.fn(),
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
    await resetDatabase();
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

  afterAll(async () => {
    await prisma.$disconnect();
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

    it("returns 404 when thread is missing", async () => {
      mockChatService.deleteThread.mockRejectedValue(new ChatThreadNotFoundError());
      const res = await app.inject({ method: "DELETE", url: "/api/threads/missing" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "Chat thread not found" });
    });

    it("returns 409 when thread is still active", async () => {
      mockChatService.deleteThread.mockRejectedValue(new ChatThreadActiveConflictError());
      const res = await app.inject({ method: "DELETE", url: "/api/threads/t1" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "Cannot delete a thread while assistant is processing" });
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

  describe("GET /api/threads/:id/messages", () => {
    it("returns all messages", async () => {
      mockChatService.listMessages.mockResolvedValue([]);
      const res = await app.inject({ method: "GET", url: "/api/threads/t1/messages" });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("GET /api/threads/:id/events", () => {
    it("returns all events", async () => {
      mockChatService.listEvents.mockResolvedValue([]);
      const res = await app.inject({ method: "GET", url: "/api/threads/t1/events" });
      expect(res.statusCode).toBe(200);
    });

    it("returns 404 when thread events are requested for a missing thread", async () => {
      mockChatService.listEvents.mockRejectedValue(new ChatThreadNotFoundError());
      const res = await app.inject({ method: "GET", url: "/api/threads/missing/events" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "Chat thread not found" });
    });
  });

  describe("GET /api/threads/:id/snapshot", () => {
    it("returns thread snapshot", async () => {
      mockChatService.listThreadSnapshot.mockResolvedValue({
        messages: [],
        events: [],
        timeline: {
          timelineItems: [],
          summary: {
            oldestRenderableKey: null,
            oldestRenderableKind: null,
            oldestRenderableMessageId: null,
            oldestRenderableHydrationPending: false,
            headIdentityStable: true,
          },
          newestSeq: null,
          newestIdx: null,
          messages: [],
          events: [],
        },
      });
      const res = await app.inject({ method: "GET", url: "/api/threads/t1/snapshot" });
      expect(res.statusCode).toBe(200);
    });

    it("returns 404 when thread snapshot is requested for a missing thread", async () => {
      mockChatService.listThreadSnapshot.mockRejectedValue(new ChatThreadNotFoundError());
      const res = await app.inject({ method: "GET", url: "/api/threads/missing/snapshot" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "Chat thread not found" });
    });
  });

  describe("GET /api/threads/:id/timeline", () => {
    it("returns 404 when timeline is requested for a missing thread", async () => {
      mockChatService.listThreadSnapshot.mockRejectedValue(new ChatThreadNotFoundError());
      const res = await app.inject({ method: "GET", url: "/api/threads/missing/timeline" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "Chat thread not found" });
    });

    it("does not leak overlap-unresolved subagent explore events into top-level explore cards", async () => {
      const suffix = uniqueSuffix();
      const repository = await prisma.repository.create({
        data: {
          name: `repo-${suffix}`,
          rootPath: `/tmp/routes-chat-${suffix}`,
          defaultBranch: "main",
        },
      });
      const worktree = await prisma.worktree.create({
        data: {
          repositoryId: repository.id,
          branch: "main",
          baseBranch: "main",
          path: repository.rootPath,
          status: "active",
        },
      });
      const thread = await prisma.chatThread.create({
        data: {
          worktreeId: worktree.id,
          title: "New Thread",
        },
      });
      const assistantMessage = await prisma.chatMessage.create({
        data: {
          threadId: thread.id,
          seq: 1,
          role: "assistant",
          content: "running",
        },
      });

      const hub = createEventHub(prisma);
      await hub.emit(thread.id, "tool.started", { toolName: "Task", toolUseId: "call-1" });
      await hub.emit(thread.id, "subagent.started", { toolUseId: "sa-1", agentId: "agent-1", agentType: "Explore", description: "First" });
      await hub.emit(thread.id, "tool.started", { toolName: "Task", toolUseId: "call-2" });
      await hub.emit(thread.id, "subagent.started", { toolUseId: "sa-2", agentId: "agent-2", agentType: "Explore", description: "Second" });
      await hub.emit(thread.id, "tool.started", {
        toolName: "Read",
        toolUseId: "ambiguous-read",
        ownershipReason: "unresolved_overlap_no_lineage",
        activeSubagentToolUseIds: ["sa-1", "sa-2"],
      });
      await hub.emit(thread.id, "tool.finished", {
        toolName: "Read",
        toolUseId: "ambiguous-read-finished",
        precedingToolUseIds: ["ambiguous-read"],
        summary: "Read maybe",
        ownershipReason: "unresolved_overlap_no_lineage",
        activeSubagentToolUseIds: ["sa-1", "sa-2"],
      });
      await hub.emit(thread.id, "subagent.finished", { toolUseId: "sa-1", lastMessage: "done 1" });
      await hub.emit(thread.id, "subagent.finished", { toolUseId: "sa-2", lastMessage: "done 2" });
      await hub.emit(thread.id, "chat.completed", { messageId: assistantMessage.id });

      const realChatService = createChatService({
        prisma,
        eventHub: hub,
        agentRunner: vi.fn(),
        modelProviderService: { getActiveProvider: async () => null },
      });
      app.chatService = realChatService as never;

      const res = await app.inject({ method: "GET", url: `/api/threads/${thread.id}/timeline` });
      expect(res.statusCode).toBe(200);

      const timelineItems = res.json().data.timelineItems as Array<Record<string, unknown>>;
      const exploreItems = timelineItems.filter((item) => item.kind === "explore-activity");
      const activityItems = timelineItems.filter((item) => item.kind === "activity");
      const subagentItems = timelineItems.filter((item) => item.kind === "subagent-activity");

      expect(exploreItems).toHaveLength(0);
      expect(activityItems).toHaveLength(0);
      expect(subagentItems).toHaveLength(2);
    });
  });

  describe("GET /api/threads/:id/events/stream", () => {
    it("returns 404 when stream is requested for a missing thread", async () => {
      mockChatService.getThreadById.mockResolvedValue(null);
      const res = await app.inject({ method: "GET", url: "/api/threads/missing/events/stream" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "Chat thread not found" });
      expect(mockEventHub.subscribe).not.toHaveBeenCalled();
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
