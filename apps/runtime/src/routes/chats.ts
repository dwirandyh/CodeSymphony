import type { FastifyInstance } from "fastify";
import type { ChatEvent } from "@codesymphony/shared-types";
import path from "node:path";
import { z } from "zod";
import { appendRuntimeDebugLog } from "./debug.js";

const repositoryParams = z.object({ id: z.string().min(1) });
const worktreeParams = z.object({ id: z.string().min(1) });
const threadParams = z.object({ id: z.string().min(1) });
const streamEventQuery = z.object({ afterIdx: z.string().optional() }).strict();
const STREAM_PREFLUSH_BUFFER_LIMIT = 1000;
const messagesPageQuery = z.object({
  beforeSeq: z.string().optional(),
  limit: z.string().optional(),
}).strict();
const eventsPageQuery = z.object({
  beforeIdx: z.string().optional(),
  limit: z.string().optional(),
}).strict();
const threadSnapshotQuery = z.object({
  messageLimit: z.string().optional(),
  eventLimit: z.string().optional(),
}).strict();

function parseNonNegativeInt(input: unknown): number | null {
  const rawValue = Array.isArray(input) ? input[input.length - 1] : input;
  if (typeof rawValue !== "string" && typeof rawValue !== "number") {
    return null;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function parsePositiveInt(input: unknown): number | null {
  const rawValue = Array.isArray(input) ? input[input.length - 1] : input;
  if (typeof rawValue !== "string" && typeof rawValue !== "number") {
    return null;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function parseStreamStartCursor(afterIdx: unknown, lastEventId: unknown): number | undefined {
  const queryCursor = parseNonNegativeInt(afterIdx);
  const headerCursor = parseNonNegativeInt(lastEventId);

  if (queryCursor == null && headerCursor == null) {
    return undefined;
  }

  return Math.max(queryCursor ?? -1, headerCursor ?? -1);
}

export function formatSseEvent(event: ChatEvent): string {
  return `id: ${event.idx}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function stripPrivatePrefix(input: string): string {
  if (input === "/private") return "/";
  if (input.startsWith("/private/")) return input.slice("/private".length);
  return input;
}

function areLikelySameFsPath(a: string, b: string): boolean {
  const normalizedA = path.resolve(a.trim());
  const normalizedB = path.resolve(b.trim());
  if (normalizedA === normalizedB) return true;
  if (stripPrivatePrefix(normalizedA) === normalizedB) return true;
  if (normalizedA === stripPrivatePrefix(normalizedB)) return true;
  return false;
}

function summarizeMessagePage(page: {
  data: Array<{ seq: number }>;
  pageInfo: { nextBeforeSeq: number | null; hasMoreOlder: boolean; oldestSeq: number | null; newestSeq: number | null };
}) {
  return {
    count: page.data.length,
    oldestSeq: page.pageInfo.oldestSeq,
    newestSeq: page.pageInfo.newestSeq,
    nextBeforeSeq: page.pageInfo.nextBeforeSeq,
    hasMoreOlder: page.pageInfo.hasMoreOlder,
  };
}

function summarizeEventPage(page: {
  data: Array<{ idx: number }>;
  pageInfo: { nextBeforeIdx: number | null; hasMoreOlder: boolean; oldestIdx: number | null; newestIdx: number | null };
}) {
  return {
    count: page.data.length,
    oldestIdx: page.pageInfo.oldestIdx,
    newestIdx: page.pageInfo.newestIdx,
    nextBeforeIdx: page.pageInfo.nextBeforeIdx,
    hasMoreOlder: page.pageInfo.hasMoreOlder,
  };
}

export async function registerChatRoutes(app: FastifyInstance) {
  app.get("/worktrees/:id/threads", async (request, reply) => {
    const params = worktreeParams.parse(request.params);

    try {
      const threads = await app.chatService.listThreads(params.id);
      return { data: threads };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list threads";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/worktrees/:id/threads", async (request, reply) => {
    const params = worktreeParams.parse(request.params);

    try {
      const thread = await app.chatService.createThread(params.id, request.body);
      return reply.code(201).send({ data: thread });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create thread";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/repositories/:id/threads", async (request, reply) => {
    const params = repositoryParams.parse(request.params);

    try {
      const repository = await app.repositoryService.getById(params.id);
      if (!repository) {
        return reply.code(404).send({ error: "Repository not found" });
      }

      const rootWorktree = repository.worktrees.find((worktree) =>
        worktree.status === "active" && areLikelySameFsPath(worktree.path, repository.rootPath),
      ) ?? null;
      const targetWorktree = rootWorktree
        ?? repository.worktrees.find((worktree) => worktree.status === "active")
        ?? repository.worktrees[0]
        ?? null;

      if (!targetWorktree) {
        return reply.code(400).send({ error: "No available worktree for repository" });
      }

      app.log.info(
        {
          repositoryId: repository.id,
          repositoryRootPath: repository.rootPath,
          targetWorktreeId: targetWorktree.id,
          targetWorktreePath: targetWorktree.path,
          targetWorktreeBranch: targetWorktree.branch,
          targetReason: rootWorktree ? "root-worktree" : "fallback-active-worktree",
        },
        "create thread for repository",
      );

      const thread = await app.chatService.createThread(targetWorktree.id, request.body);
      return reply.code(201).send({ data: thread });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create thread";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/threads/:id", async (request, reply) => {
    const params = threadParams.parse(request.params);
    const thread = await app.chatService.getThreadById(params.id);

    if (!thread) {
      return reply.code(404).send({ error: "Thread not found" });
    }

    return { data: thread };
  });

  app.patch("/threads/:id/title", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      const thread = await app.chatService.renameThreadTitle(params.id, request.body);
      return { data: thread };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to rename thread title";
      return reply.code(400).send({ error: message });
    }
  });

  app.delete("/threads/:id", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      await app.chatService.deleteThread(params.id);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete thread";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/threads/:id/messages", async (request, reply) => {
    try {
      const params = threadParams.parse(request.params);
      const query = messagesPageQuery.parse(request.query);
      const beforeSeq = query.beforeSeq == null ? undefined : parseNonNegativeInt(query.beforeSeq);
      const limit = query.limit == null ? undefined : parsePositiveInt(query.limit);

      if (query.beforeSeq != null && beforeSeq == null) {
        return reply.code(400).send({ error: "Invalid beforeSeq query value" });
      }
      if (query.limit != null && limit == null) {
        return reply.code(400).send({ error: "Invalid limit query value" });
      }

      const requestId = `messages-page-${params.id}-${Date.now()}`;
      appendRuntimeDebugLog({
        source: "runtime.chats",
        message: "chat.backend.messagesPage.requested",
        data: {
          requestId,
          threadId: params.id,
          beforeSeq: beforeSeq ?? null,
          limit: limit ?? null,
        },
      });
      const page = await app.chatService.listMessagesPage(params.id, {
        beforeSeq: beforeSeq ?? undefined,
        limit: limit ?? undefined,
      });
      appendRuntimeDebugLog({
        source: "runtime.chats",
        message: "chat.backend.messagesPage.response",
        data: {
          requestId,
          threadId: params.id,
          beforeSeq: beforeSeq ?? null,
          limit: limit ?? null,
          ...summarizeMessagePage(page),
        },
      });
      return {
        data: page.data,
        pageInfo: page.pageInfo,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list messages";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/threads/:id/snapshot", async (request, reply) => {
    try {
      const params = threadParams.parse(request.params);
      const query = threadSnapshotQuery.parse(request.query);
      const messageLimit = query.messageLimit == null ? undefined : parsePositiveInt(query.messageLimit);
      const eventLimit = query.eventLimit == null ? undefined : parsePositiveInt(query.eventLimit);

      if (query.messageLimit != null && messageLimit == null) {
        return reply.code(400).send({ error: "Invalid messageLimit query value" });
      }
      if (query.eventLimit != null && eventLimit == null) {
        return reply.code(400).send({ error: "Invalid eventLimit query value" });
      }

      const requestId = `snapshot-${params.id}-${Date.now()}`;
      appendRuntimeDebugLog({
        source: "runtime.chats",
        message: "chat.backend.snapshot.requested",
        data: {
          requestId,
          threadId: params.id,
          messageLimit: messageLimit ?? null,
          eventLimit: eventLimit ?? null,
        },
      });
      const snapshot = await app.chatService.listThreadSnapshot(params.id, {
        messageLimit: messageLimit ?? undefined,
        eventLimit: eventLimit ?? undefined,
      });
      appendRuntimeDebugLog({
        source: "runtime.chats",
        message: "chat.backend.snapshot.response",
        data: {
          requestId,
          threadId: params.id,
          messageLimit: messageLimit ?? null,
          eventLimit: eventLimit ?? null,
          messages: summarizeMessagePage(snapshot.messages),
          events: summarizeEventPage(snapshot.events),
        },
      });

      return { data: snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load thread snapshot";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/threads/:id/messages", { bodyLimit: 15 * 1024 * 1024 }, async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      const message = await app.chatService.sendMessage(params.id, request.body);
      return reply.code(201).send({ data: message });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to send message";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/threads/:id/stop", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      await app.chatService.stopRun(params.id);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to stop run";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/threads/:id/questions/answer", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      await app.chatService.answerQuestion(params.id, request.body);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to answer question";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/threads/:id/questions/dismiss", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      await app.chatService.dismissQuestion(params.id, request.body);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to dismiss question";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/threads/:id/plan/approve", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      await app.chatService.approvePlan(params.id);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to approve plan";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/threads/:id/plan/revise", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      await app.chatService.revisePlan(params.id, request.body);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to revise plan";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/threads/:id/permissions/resolve", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      await app.chatService.resolvePermission(params.id, request.body);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to resolve permission";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/threads/:id/events", async (request, reply) => {
    try {
      const params = threadParams.parse(request.params);
      const query = eventsPageQuery.parse(request.query);
      const beforeIdx = query.beforeIdx == null ? undefined : parseNonNegativeInt(query.beforeIdx);
      const limit = query.limit == null ? undefined : parsePositiveInt(query.limit);

      if (query.beforeIdx != null && beforeIdx == null) {
        return reply.code(400).send({ error: "Invalid beforeIdx query value" });
      }
      if (query.limit != null && limit == null) {
        return reply.code(400).send({ error: "Invalid limit query value" });
      }

      const requestId = `events-page-${params.id}-${Date.now()}`;
      appendRuntimeDebugLog({
        source: "runtime.chats",
        message: "chat.backend.eventsPage.requested",
        data: {
          requestId,
          threadId: params.id,
          beforeIdx: beforeIdx ?? null,
          limit: limit ?? null,
        },
      });
      const page = await app.chatService.listEventsPage(params.id, {
        beforeIdx: beforeIdx ?? undefined,
        limit: limit ?? undefined,
      });
      appendRuntimeDebugLog({
        source: "runtime.chats",
        message: "chat.backend.eventsPage.response",
        data: {
          requestId,
          threadId: params.id,
          beforeIdx: beforeIdx ?? null,
          limit: limit ?? null,
          ...summarizeEventPage(page),
        },
      });
      return {
        data: page.data,
        pageInfo: page.pageInfo,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list events";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/threads/:id/events/stream", async (request, reply) => {
    try {
      const params = threadParams.parse(request.params);
      const query = streamEventQuery.parse(request.query);
      const startCursor = parseStreamStartCursor(query.afterIdx, request.headers["last-event-id"]);
      const streamRequestId = `sse-${params.id}-${Date.now()}`;

      appendRuntimeDebugLog({
        source: "runtime.chats",
        message: "chat.backend.sse.started",
        data: {
          requestId: streamRequestId,
          threadId: params.id,
          afterIdxQuery: query.afterIdx ?? null,
          lastEventIdHeader: request.headers["last-event-id"] ?? null,
          startCursor: startCursor ?? null,
        },
      });

      const requestOrigin = request.headers.origin;

      if (requestOrigin) {
        reply.raw.setHeader("Access-Control-Allow-Origin", requestOrigin);
        reply.raw.setHeader("Vary", "Origin");
      }

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");

      // Subscribe FIRST to avoid gaps between history fetch and live subscription
      const buffer: ChatEvent[] = [];
      let flushed = false;
      const unsubscribe = app.eventHub.subscribe(params.id, (event) => {
        if (!flushed) {
          if (buffer.length >= STREAM_PREFLUSH_BUFFER_LIMIT) {
            buffer.shift();
          }
          buffer.push(event);
          return;
        }
        reply.raw.write(formatSseEvent(event));
      });

      const history = await app.chatService.listEvents(params.id, startCursor);
      appendRuntimeDebugLog({
        source: "runtime.chats",
        message: "chat.backend.sse.historyFlushed",
        data: {
          requestId: streamRequestId,
          threadId: params.id,
          startCursor: startCursor ?? null,
          historyCount: history.length,
          oldestHistoryIdx: history[0]?.idx ?? null,
          newestHistoryIdx: history[history.length - 1]?.idx ?? null,
          bufferedCountBeforeFlush: buffer.length,
        },
      });
      const seenIdx = new Set<number>();
      for (const event of history) {
        seenIdx.add(event.idx);
        reply.raw.write(formatSseEvent(event));
      }

      let bufferedDeliveredCount = 0;
      for (const event of buffer) {
        if (!seenIdx.has(event.idx)) {
          reply.raw.write(formatSseEvent(event));
          bufferedDeliveredCount += 1;
        }
      }
      flushed = true;
      appendRuntimeDebugLog({
        source: "runtime.chats",
        message: "chat.backend.sse.bufferFlushed",
        data: {
          requestId: streamRequestId,
          threadId: params.id,
          bufferedCountBeforeFlush: buffer.length,
          bufferedDeliveredCount,
        },
      });

      const heartbeat = setInterval(() => {
        reply.raw.write(": ping\n\n");
      }, 15000);

      request.raw.on("close", () => {
        appendRuntimeDebugLog({
          source: "runtime.chats",
          message: "chat.backend.sse.closed",
          data: {
            requestId: streamRequestId,
            threadId: params.id,
            bufferedCountAtClose: buffer.length,
          },
        });
        clearInterval(heartbeat);
        unsubscribe();
      });

      await new Promise<void>((resolve) => {
        request.raw.on("close", () => resolve());
      });

      return reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to stream events";
      return reply.code(400).send({ error: message });
    }
  });
}
