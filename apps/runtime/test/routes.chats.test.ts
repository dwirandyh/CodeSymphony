import Fastify, { type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import { createChatService } from "../src/services/chat";
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
    : "file:./test.db";

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
    updateThreadMode: vi.fn(),
    updateThreadPermissionMode: vi.fn(),
    updateThreadAgentSelection: vi.fn(),
    sendMessage: vi.fn(),
    resolvePermission: vi.fn(),
    answerQuestion: vi.fn(),
    dismissQuestion: vi.fn(),
    approvePlan: vi.fn(),
    dismissPlan: vi.fn(),
    revisePlan: vi.fn(),
    stopRun: vi.fn(),
    listMessages: vi.fn(),
    listEvents: vi.fn(),
    listThreadSnapshot: vi.fn(),
    listSlashCommands: vi.fn(),
  };

  const mockEventHub = {
    list: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  };

  const mockRepositoryService = {
    getById: vi.fn(),
  };

  const mockWorktreeService = {
    getById: vi.fn(),
  };

  const mockWorkspaceEventHub = {
    emit: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    await resetDatabase();
    app = Fastify({ logger: false });
    app.decorate("chatService", mockChatService as never);
    app.decorate("eventHub", mockEventHub as never);
    app.decorate("repositoryService", mockRepositoryService as never);
    app.decorate("worktreeService", mockWorktreeService as never);
    app.decorate("workspaceEventHub", mockWorkspaceEventHub as never);
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
      mockChatService.listThreads.mockResolvedValue([{ id: "t1", title: "Test", mode: "default", permissionMode: "default" }]);
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
      mockChatService.createThread.mockResolvedValue({ id: "t-new", title: "New", mode: "default", permissionMode: "default" });
      const res = await app.inject({ method: "POST", url: "/api/worktrees/w1/threads", payload: {} });
      expect(res.statusCode).toBe(201);
    });

    it("returns 400 on error", async () => {
      mockChatService.createThread.mockRejectedValue(new Error("fail"));
      const res = await app.inject({ method: "POST", url: "/api/worktrees/w1/threads", payload: {} });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/worktrees/:id/slash-commands", () => {
    it("lists slash commands for a worktree", async () => {
      mockChatService.listSlashCommands.mockResolvedValue({
        commands: [{ name: "commit", description: "Create a commit", argumentHint: "" }],
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const res = await app.inject({ method: "GET", url: "/api/worktrees/w1/slash-commands" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.commands).toHaveLength(1);
      expect(mockChatService.listSlashCommands).toHaveBeenCalledWith("w1", "claude");
    });

    it("passes the selected agent through to slash command listing", async () => {
      mockChatService.listSlashCommands.mockResolvedValue({
        commands: [{ name: "dogfood", description: "QA a web app", argumentHint: "" }],
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const res = await app.inject({ method: "GET", url: "/api/worktrees/w1/slash-commands?agent=codex" });
      expect(res.statusCode).toBe(200);
      expect(mockChatService.listSlashCommands).toHaveBeenCalledWith("w1", "codex");
    });

    it("accepts Cursor as a valid slash-command agent", async () => {
      mockChatService.listSlashCommands.mockResolvedValue({
        commands: [{ name: "bug", description: "Report a bug", argumentHint: "" }],
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const res = await app.inject({ method: "GET", url: "/api/worktrees/w1/slash-commands?agent=cursor" });
      expect(res.statusCode).toBe(200);
      expect(mockChatService.listSlashCommands).toHaveBeenCalledWith("w1", "cursor");
    });

    it("returns 404 when worktree is missing", async () => {
      mockChatService.listSlashCommands.mockRejectedValue(new Error("Worktree not found"));

      const res = await app.inject({ method: "GET", url: "/api/worktrees/missing/slash-commands" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/threads/:id", () => {
    it("returns thread data", async () => {
      mockChatService.getThreadById.mockResolvedValue({ id: "t1", title: "Test", mode: "default", permissionMode: "default" });
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
      mockChatService.renameThreadTitle.mockResolvedValue({ id: "t1", title: "New", mode: "default", permissionMode: "default" });
      const res = await app.inject({
        method: "PATCH",
        url: "/api/threads/t1/title",
        payload: { title: "New" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("returns 404 when thread is missing", async () => {
      mockChatService.renameThreadTitle.mockRejectedValue(new Error("Chat thread not found"));
      const res = await app.inject({
        method: "PATCH",
        url: "/api/threads/t1/title",
        payload: { title: "New" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 400 on other errors", async () => {
      mockChatService.renameThreadTitle.mockRejectedValue(new Error("bad"));
      const res = await app.inject({
        method: "PATCH",
        url: "/api/threads/t1/title",
        payload: { title: "" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PATCH /api/threads/:id/mode", () => {
    it("updates thread mode", async () => {
      mockChatService.updateThreadMode.mockResolvedValue({ id: "t1", title: "Test", mode: "plan", permissionMode: "default" });
      const res = await app.inject({
        method: "PATCH",
        url: "/api/threads/t1/mode",
        payload: { mode: "plan" },
      });
      expect(res.statusCode).toBe(200);
      expect(mockChatService.updateThreadMode).toHaveBeenCalledWith("t1", { mode: "plan" });
    });

    it("updates thread permission mode", async () => {
      mockChatService.updateThreadPermissionMode.mockResolvedValue({
        id: "t1",
        title: "Test",
        mode: "default",
        permissionMode: "full_access",
      });
      const res = await app.inject({
        method: "PATCH",
        url: "/api/threads/t1/permission-mode",
        payload: { permissionMode: "full_access" },
      });
      expect(res.statusCode).toBe(200);
      expect(mockChatService.updateThreadPermissionMode).toHaveBeenCalledWith("t1", { permissionMode: "full_access" });
    });

    it("returns 404 when thread is missing", async () => {
      mockChatService.updateThreadMode.mockRejectedValue(new Error("Chat thread not found"));
      const res = await app.inject({
        method: "PATCH",
        url: "/api/threads/t1/mode",
        payload: { mode: "plan" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 400 on other errors", async () => {
      mockChatService.updateThreadMode.mockRejectedValue(new Error("bad"));
      const res = await app.inject({
        method: "PATCH",
        url: "/api/threads/t1/mode",
        payload: { mode: "plan" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PATCH /api/threads/:id/agent-selection", () => {
    it("accepts Cursor as a valid agent selection payload", async () => {
      mockChatService.updateThreadAgentSelection.mockResolvedValue({
        id: "t1",
        title: "Cursor Thread",
        mode: "default",
        permissionMode: "default",
        agent: "cursor",
        model: "default[]",
      });
      const res = await app.inject({
        method: "PATCH",
        url: "/api/threads/t1/agent-selection",
        payload: {
          agent: "cursor",
          model: "default[]",
          modelProviderId: null,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockChatService.updateThreadAgentSelection).toHaveBeenCalledWith("t1", {
        agent: "cursor",
        model: "default[]",
        modelProviderId: null,
      });
    });
  });

  describe("DELETE /api/threads/:id", () => {
    it("deletes a thread (204)", async () => {
      mockChatService.getThreadById.mockResolvedValue({ id: "t1", worktreeId: "w1" });
      mockChatService.deleteThread.mockResolvedValue(undefined);
      const res = await app.inject({ method: "DELETE", url: "/api/threads/t1" });
      expect(res.statusCode).toBe(204);
    });

    it("returns 404 when thread is missing", async () => {
      mockChatService.getThreadById.mockResolvedValue(null);
      const res = await app.inject({ method: "DELETE", url: "/api/threads/t1" });
      expect(res.statusCode).toBe(404);
    });

    it("returns 409 when thread is still running", async () => {
      mockChatService.getThreadById.mockResolvedValue({ id: "t1", worktreeId: "w1" });
      mockChatService.deleteThread.mockRejectedValue(new Error("Cannot delete a thread while assistant is processing"));
      const res = await app.inject({ method: "DELETE", url: "/api/threads/t1" });
      expect(res.statusCode).toBe(409);
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

  describe("POST /api/threads/:id/plan/dismiss", () => {
    it("dismisses a plan (204)", async () => {
      mockChatService.dismissPlan.mockResolvedValue(undefined);
      const res = await app.inject({ method: "POST", url: "/api/threads/t1/plan/dismiss", payload: {} });
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

    it("returns 404 when thread is missing", async () => {
      mockChatService.listMessages.mockRejectedValue(new Error("Chat thread not found"));
      const res = await app.inject({ method: "GET", url: "/api/threads/t1/messages" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/threads/:id/events", () => {
    it("returns all events", async () => {
      mockChatService.listEvents.mockResolvedValue([]);
      const res = await app.inject({ method: "GET", url: "/api/threads/t1/events" });
      expect(res.statusCode).toBe(200);
    });

    it("returns 404 when thread is missing", async () => {
      mockChatService.listEvents.mockRejectedValue(new Error("Chat thread not found"));
      const res = await app.inject({ method: "GET", url: "/api/threads/t1/events" });
      expect(res.statusCode).toBe(404);
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

    it("returns 404 when thread is missing", async () => {
      mockChatService.listThreadSnapshot.mockRejectedValue(new Error("Chat thread not found"));
      const res = await app.inject({ method: "GET", url: "/api/threads/t1/snapshot" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/threads/:id/events/stream", () => {
    it("returns 404 when thread is missing before opening SSE", async () => {
      mockChatService.getThreadById.mockResolvedValue(null);
      const res = await app.inject({ method: "GET", url: "/api/threads/t1/events/stream" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/threads/:id/timeline", () => {
    it("passes includeCollections false for display timeline snapshots", async () => {
      mockChatService.listThreadSnapshot.mockResolvedValue({
        messages: [],
        events: [],
        timeline: {
          timelineItems: [],
          summary: {
            oldestRenderableKey: null,
            oldestRenderableKind: null,
            oldestRenderableMessageId: null,
            oldestRenderableHydrationPending: true,
            headIdentityStable: true,
          },
          newestSeq: 10,
          newestIdx: 200,
          collectionsIncluded: false,
          messages: [],
          events: [],
        },
      });

      const res = await app.inject({ method: "GET", url: "/api/threads/t1/timeline?includeCollections=0" });

      expect(res.statusCode).toBe(200);
      expect(mockChatService.listThreadSnapshot).toHaveBeenCalledWith("t1", expect.objectContaining({
        includeCollections: false,
        paginated: false,
        beforeEventIdx: null,
        beforeMessageSeq: null,
        onTiming: expect.any(Function),
      }));
      expect(res.json().data.collectionsIncluded).toBe(false);
    });

    it("passes paginated older-history cursors through for timeline page requests", async () => {
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
          newestSeq: 24,
          newestIdx: 600,
          collectionsIncluded: true,
          messages: [],
          events: [],
        },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/threads/t1/timeline?includeCollections=1&paginated=1&beforeEventIdx=120&beforeMessageSeq=8",
      });

      expect(res.statusCode).toBe(200);
      expect(mockChatService.listThreadSnapshot).toHaveBeenCalledWith("t1", expect.objectContaining({
        includeCollections: true,
        paginated: true,
        beforeEventIdx: 120,
        beforeMessageSeq: 8,
        onTiming: expect.any(Function),
      }));
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
        claudeRunner: vi.fn(),
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

    it("keeps explore diagnosis and single-edit completion ordered around mid-sentence tool starts", async () => {
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
          title: "OTP support email fix",
        },
      });
      await prisma.chatMessage.create({
        data: {
          threadId: thread.id,
          seq: 0,
          role: "user",
          content: "kenapa subject email kosong?",
        },
      });
      const diagnosisMessage = await prisma.chatMessage.create({
        data: {
          threadId: thread.id,
          seq: 1,
          role: "assistant",
          content: "Sekarang mari saya cari Activity Kotlin/Java yang menangani klik tombol bantuan tersebut:Saya menemukan masalahnya!",
        },
      });
      await prisma.chatMessage.create({
        data: {
          threadId: thread.id,
          seq: 2,
          role: "user",
          content: "yaa perbaiki",
        },
      });
      const editMessage = await prisma.chatMessage.create({
        data: {
          threadId: thread.id,
          seq: 3,
          role: "assistant",
          content: "Baik, saya akan memperbaiki kode tersebut sekarang.Sip! Perbaikan sudah dilakukan.",
        },
      });

      const hub = createEventHub(prisma);
      await hub.emit(thread.id, "message.delta", {
        messageId: diagnosisMessage.id,
        role: "assistant",
        delta: "Sekarang mari saya cari Activity Kotlin/",
      });
      await hub.emit(thread.id, "tool.started", {
        toolName: "Glob",
        toolUseId: "glob-otp",
        searchParams: "pattern=**/*OTPLogin*.{kt,java}",
      });
      await hub.emit(thread.id, "message.delta", {
        messageId: diagnosisMessage.id,
        role: "assistant",
        delta: "Java yang menangani klik tombol bantuan tersebut:",
      });
      await hub.emit(thread.id, "tool.finished", {
        toolName: "Glob",
        summary: "Completed Glob",
        precedingToolUseIds: ["glob-otp"],
      });
      await hub.emit(thread.id, "message.delta", {
        messageId: diagnosisMessage.id,
        role: "assistant",
        delta: "Saya menemukan masalahnya!",
      });
      await hub.emit(thread.id, "chat.completed", { messageId: diagnosisMessage.id });

      await hub.emit(thread.id, "message.delta", {
        messageId: editMessage.id,
        role: "assistant",
        delta: "Baik, saya akan",
      });
      await hub.emit(thread.id, "tool.started", {
        toolName: "Edit",
        toolUseId: "edit-otp",
        toolInput: {
          file_path: `${repository.rootPath}/OTPLoginActivity.java`,
          old_string: "a",
          new_string: "b",
        },
      });
      await hub.emit(thread.id, "message.delta", {
        messageId: editMessage.id,
        role: "assistant",
        delta: " memperbaiki kode tersebut sekarang.",
      });
      await hub.emit(thread.id, "tool.finished", {
        toolName: "Edit",
        summary: `Edited ${repository.rootPath}/OTPLoginActivity.java`,
        precedingToolUseIds: ["edit-otp"],
        editTarget: `${repository.rootPath}/OTPLoginActivity.java`,
      });
      await hub.emit(thread.id, "message.delta", {
        messageId: editMessage.id,
        role: "assistant",
        delta: "Sip! Perbaikan sudah dilakukan.",
      });
      await hub.emit(thread.id, "tool.finished", {
        source: "worktree.diff",
        summary: "Edited 1 file",
        changedFiles: [`${repository.rootPath}/OTPLoginActivity.java`],
        diff: [
          "diff --git a/OTPLoginActivity.java b/OTPLoginActivity.java",
          "--- a/OTPLoginActivity.java",
          "+++ b/OTPLoginActivity.java",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
      });
      await hub.emit(thread.id, "chat.completed", { messageId: editMessage.id });

      const realChatService = createChatService({
        prisma,
        eventHub: hub,
        claudeRunner: vi.fn(),
        modelProviderService: { getActiveProvider: async () => null },
      });
      app.chatService = realChatService as never;

      const res = await app.inject({ method: "GET", url: `/api/threads/${thread.id}/timeline` });
      expect(res.statusCode).toBe(200);

      const timelineItems = res.json().data.timelineItems as Array<Record<string, any>>;
      const announcementIndex = timelineItems.findIndex(
        (item) => item.kind === "message" && item.message?.content?.includes("Sekarang mari saya cari Activity Kotlin/Java yang menangani klik tombol bantuan tersebut:"),
      );
      const exploreIndex = timelineItems.findIndex((item) => item.kind === "explore-activity");
      const diagnosisIndex = timelineItems.findIndex(
        (item) => item.kind === "message" && item.message?.content?.includes("Saya menemukan masalahnya!"),
      );
      const preEditIndex = timelineItems.findIndex(
        (item) => item.kind === "message" && item.message?.content?.includes("Baik, saya akan memperbaiki kode tersebut sekarang."),
      );
      const editIndex = timelineItems.findIndex(
        (item) => item.kind === "edited-diff" && item.changedFiles?.some((file: string) => file.includes("OTPLoginActivity.java")),
      );
      const completionIndex = timelineItems.findIndex(
        (item) => item.kind === "message" && item.message?.content?.includes("Sip! Perbaikan sudah dilakukan."),
      );

      expect(announcementIndex).toBeGreaterThan(-1);
      expect(exploreIndex).toBeGreaterThan(-1);
      expect(diagnosisIndex).toBeGreaterThan(-1);
      expect(preEditIndex).toBeGreaterThan(-1);
      expect(editIndex).toBeGreaterThan(-1);
      expect(completionIndex).toBeGreaterThan(-1);
      expect(announcementIndex).toBeLessThan(exploreIndex);
      expect(exploreIndex).toBeLessThan(diagnosisIndex);
      expect(preEditIndex).toBeLessThan(editIndex);
      expect(editIndex).toBeLessThan(completionIndex);
      expect(timelineItems[editIndex]).toMatchObject({ kind: "edited-diff", diffKind: "actual" });
    });

    it("keeps warning text after a finished bash card in chronological order", async () => {
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
          title: "Build check",
        },
      });
      await prisma.chatMessage.create({
        data: {
          threadId: thread.id,
          seq: 0,
          role: "user",
          content: "coba check apakah build berhasil?",
        },
      });
      const assistantMessage = await prisma.chatMessage.create({
        data: {
          threadId: thread.id,
          seq: 1,
          role: "assistant",
          content: "Baik, saya akan cek apakah build berhasil:✅ **BUILD SUCCESSFUL!**\n\nBuild berhasil dalam 1 menit 57 detik. Tidak ada error sama sekali, hanya beberapa warnings tentang deprecated API dan unused parameters yang tidak mempengaruhi fungsi aplikasi.\n\nSekarang perbaikan email di halaman OTP login sudah selesai dan siap digunakan! 📧",
        },
      });

      const hub = createEventHub(prisma);
      await hub.emit(thread.id, "message.delta", {
        messageId: assistantMessage.id,
        role: "assistant",
        delta: "Baik, saya akan c",
      });
      await hub.emit(thread.id, "tool.started", {
        toolName: "Bash",
        toolUseId: "bash-build",
        command: "./gradlew assembleDebug 2>&1 | tail -50",
        shell: "bash",
        isBash: true,
      });
      await hub.emit(thread.id, "tool.finished", {
        toolName: "Bash",
        toolUseId: "bash-build",
        precedingToolUseIds: ["bash-build"],
        summary: "Ran ./gradlew assembleDebug 2>&1 | tail -50",
        command: "./gradlew assembleDebug 2>&1 | tail -50",
        shell: "bash",
        isBash: true,
        output: "BUILD SUCCESSFUL in 1m 57s",
      });
      await hub.emit(thread.id, "message.delta", {
        messageId: assistantMessage.id,
        role: "assistant",
        delta: "ek apakah build berhasil:✅ **BUILD SUCCESSFUL!**\n\nBuild berhasil dalam 1 menit 57 detik. Tidak ada error sama sekali, hanya beberapa warnings tentang deprecated API dan unused parameters yang tidak mempengaruhi fungsi aplikasi.\n\nSekarang perbaikan email di halaman OTP login sudah selesai dan siap digunakan! 📧",
      });
      await hub.emit(thread.id, "chat.completed", { messageId: assistantMessage.id });

      const realChatService = createChatService({
        prisma,
        eventHub: hub,
        claudeRunner: vi.fn(),
        modelProviderService: { getActiveProvider: async () => null },
      });
      app.chatService = realChatService as never;

      const res = await app.inject({ method: "GET", url: `/api/threads/${thread.id}/timeline` });
      expect(res.statusCode).toBe(200);

      const timelineItems = res.json().data.timelineItems as Array<Record<string, any>>;
      const buildIntroIndex = timelineItems.findIndex(
        (item) => item.kind === "message" && item.message?.content?.includes("Build berhasil dalam 1 menit 57 detik."),
      );
      const toolIndex = timelineItems.findIndex(
        (item) => item.kind === "tool" && item.summary === "Ran ./gradlew assembleDebug 2>&1 | tail -50",
      );
      const warningIndex = timelineItems.findIndex(
        (item) => item.kind === "message" && item.message?.content?.includes("Tidak ada error sama sekali"),
      );
      const summaryIndex = timelineItems.findIndex(
        (item) => item.kind === "message" && item.message?.content?.includes("Sekarang perbaikan email di halaman OTP login sudah selesai"),
      );

      expect(buildIntroIndex).toBeGreaterThan(-1);
      expect(toolIndex).toBeGreaterThan(-1);
      expect(warningIndex).toBeGreaterThan(-1);
      expect(summaryIndex).toBeGreaterThan(-1);
      expect(buildIntroIndex).toBeLessThan(toolIndex);
      expect(toolIndex).toBeLessThan(warningIndex);
      expect(warningIndex).toBeLessThan(summaryIndex);
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

    it("returns 400 when active root worktree is missing", async () => {
      mockRepositoryService.getById.mockResolvedValue({
        id: "r1",
        rootPath: "/home/repo",
        worktrees: [{ id: "wt-1", path: "/home/repo/feature", status: "active", branch: "feature/test" }],
      });
      const res = await app.inject({ method: "POST", url: "/api/repositories/r1/threads", payload: {} });
      expect(res.statusCode).toBe(400);
      expect(mockChatService.createThread).not.toHaveBeenCalled();
    });
  });
});
