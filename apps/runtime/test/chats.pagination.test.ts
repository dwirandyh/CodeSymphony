import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerChatRoutes } from "../src/routes/chats";

describe("chat pagination routes", () => {
  let app: FastifyInstance;
  const listMessagesPage = vi.fn();
  const listEventsPage = vi.fn();
  const listThreadSnapshot = vi.fn();

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.decorate("repositoryService", {
      getById: vi.fn(),
    } as never);
    app.decorate("chatService", {
      listThreads: vi.fn(),
      createThread: vi.fn(),
      getThreadById: vi.fn(),
      renameThreadTitle: vi.fn(),
      deleteThread: vi.fn(),
      listMessages: vi.fn(),
      listMessagesPage,
      sendMessage: vi.fn(),
      stopRun: vi.fn(),
      answerQuestion: vi.fn(),
      dismissQuestion: vi.fn(),
      approvePlan: vi.fn(),
      revisePlan: vi.fn(),
      resolvePermission: vi.fn(),
      listEvents: vi.fn(),
      listEventsPage,
      listThreadSnapshot,
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

  it("returns paged messages with cursor params", async () => {
    listMessagesPage.mockResolvedValueOnce({
      data: [{
        id: "msg-1",
        threadId: "thread-1",
        seq: 8,
        role: "assistant",
        content: "Hello",
        attachments: [],
        createdAt: "2026-02-01T00:00:00.000Z",
      }],
      pageInfo: {
        hasMoreOlder: true,
        nextBeforeSeq: 8,
        oldestSeq: 8,
        newestSeq: 8,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/threads/thread-1/messages?beforeSeq=10&limit=2",
    });

    expect(response.statusCode).toBe(200);
    expect(listMessagesPage).toHaveBeenCalledWith("thread-1", { beforeSeq: 10, limit: 2 });
    expect(response.json()).toMatchObject({
      data: [{ id: "msg-1", seq: 8 }],
      pageInfo: { hasMoreOlder: true, nextBeforeSeq: 8 },
    });
  });

  it("returns 400 for invalid messages limit", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/threads/thread-1/messages?limit=0",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Invalid limit query value" });
  });

  it("returns thread snapshot with page data and watermarks", async () => {
    listThreadSnapshot.mockResolvedValueOnce({
      messages: {
        data: [{
          id: "msg-1",
          threadId: "thread-1",
          seq: 8,
          role: "assistant",
          content: "Hello",
          attachments: [],
          createdAt: "2026-02-01T00:00:00.000Z",
        }],
        pageInfo: {
          hasMoreOlder: true,
          nextBeforeSeq: 8,
          oldestSeq: 8,
          newestSeq: 8,
        },
      },
      events: {
        data: [{
          id: "evt-1",
          threadId: "thread-1",
          idx: 101,
          type: "tool.finished",
          payload: { summary: "done" },
          createdAt: "2026-02-01T00:00:00.000Z",
        }],
        pageInfo: {
          hasMoreOlder: false,
          nextBeforeIdx: null,
          oldestIdx: 101,
          newestIdx: 101,
        },
      },
      watermarks: {
        newestSeq: 8,
        newestIdx: 101,
      },
      coverage: {
        eventsStatus: "complete",
        recommendedBackfill: false,
        nextBeforeIdx: null,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/threads/thread-1/snapshot?messageLimit=60&eventLimit=900",
    });

    expect(response.statusCode).toBe(200);
    expect(listThreadSnapshot).toHaveBeenCalledWith("thread-1", { messageLimit: 60, eventLimit: 900 });
    expect(response.json()).toMatchObject({
      data: {
        messages: { data: [{ id: "msg-1", seq: 8 }] },
        events: { data: [{ id: "evt-1", idx: 101 }] },
        watermarks: { newestSeq: 8, newestIdx: 101 },
        coverage: {
          eventsStatus: "complete",
          recommendedBackfill: false,
          nextBeforeIdx: null,
        },
      },
    });
  });

  it("returns 400 for invalid snapshot query values", async () => {
    const badMessageLimit = await app.inject({
      method: "GET",
      url: "/api/threads/thread-1/snapshot?messageLimit=0",
    });
    expect(badMessageLimit.statusCode).toBe(400);
    expect(badMessageLimit.json()).toMatchObject({ error: "Invalid messageLimit query value" });

    const badEventLimit = await app.inject({
      method: "GET",
      url: "/api/threads/thread-1/snapshot?eventLimit=-1",
    });
    expect(badEventLimit.statusCode).toBe(400);
    expect(badEventLimit.json()).toMatchObject({ error: "Invalid eventLimit query value" });
  });

  it("returns paged events and rejects deprecated afterIdx query", async () => {
    listEventsPage.mockResolvedValueOnce({
      data: [{
        id: "evt-1",
        threadId: "thread-1",
        idx: 101,
        type: "tool.finished",
        payload: { summary: "done" },
        createdAt: "2026-02-01T00:00:00.000Z",
      }],
      pageInfo: {
        hasMoreOlder: false,
        nextBeforeIdx: null,
        oldestIdx: 101,
        newestIdx: 101,
      },
    });

    const okResponse = await app.inject({
      method: "GET",
      url: "/api/threads/thread-1/events?beforeIdx=150&limit=100",
    });
    expect(okResponse.statusCode).toBe(200);
    expect(listEventsPage).toHaveBeenCalledWith("thread-1", { beforeIdx: 150, limit: 100 });
    expect(okResponse.json()).toMatchObject({
      data: [{ id: "evt-1", idx: 101 }],
      pageInfo: { nextBeforeIdx: null },
    });

    const deprecatedResponse = await app.inject({
      method: "GET",
      url: "/api/threads/thread-1/events?afterIdx=100",
    });
    expect(deprecatedResponse.statusCode).toBe(400);
  });
});
