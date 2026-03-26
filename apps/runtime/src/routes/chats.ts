import type { FastifyInstance, FastifyReply } from "fastify";
import type { ChatEvent, ChatThreadSnapshot, ChatTimelineSnapshot } from "@codesymphony/shared-types";
import path from "node:path";
import { z } from "zod";
import {
  ChatThreadActiveConflictError,
  ChatThreadNotFoundError,
} from "../services/chat/index.js";
import { appendRuntimeDebugLog } from "./debug.js";

const repositoryParams = z.object({ id: z.string().min(1) });
const worktreeParams = z.object({ id: z.string().min(1) });
const threadParams = z.object({ id: z.string().min(1) });
const deleteThreadQuery = z.object({ force: z.union([z.literal("true"), z.literal("false")]).optional() }).strict();
const streamEventQuery = z.object({ afterIdx: z.string().optional() }).strict();
const STREAM_PREFLUSH_BUFFER_LIMIT = 1000;

const inFlightSnapshotRequests = new Map<string, Promise<ChatThreadSnapshot>>();
const inFlightTimelineSnapshotRequests = new Map<string, Promise<ChatTimelineSnapshot>>();

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

function summarizeTimelineEnvelope(snapshot: ChatTimelineSnapshot) {
  return {
    timelineItemsCount: snapshot.timelineItems.length,
    newestSeq: snapshot.newestSeq,
    newestIdx: snapshot.newestIdx,
    messagesCount: snapshot.messages.length,
    eventsCount: snapshot.events.length,
  };
}

function replyForThreadRouteError(reply: FastifyReply, error: unknown, fallbackMessage: string) {
  const message = error instanceof Error ? error.message : fallbackMessage;

  if (error instanceof ChatThreadNotFoundError) {
    return reply.code(404).send({ error: message });
  }

  if (error instanceof ChatThreadActiveConflictError) {
    return reply.code(409).send({ error: message });
  }

  return reply.code(400).send({ error: message });
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
    const query = deleteThreadQuery.parse(request.query ?? {});

    try {
      await app.chatService.deleteThread(params.id, { force: query.force === "true" });
      return reply.code(204).send();
    } catch (error) {
      return replyForThreadRouteError(reply, error, "Unable to delete thread");
    }
  });

  app.get("/threads/:id/messages", async (request, reply) => {
    try {
      const params = threadParams.parse(request.params);
      const messages = await app.chatService.listMessages(params.id);
      return { data: messages };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list messages";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/threads/:id/snapshot", async (request, reply) => {
    try {
      const params = threadParams.parse(request.params);
      const snapshotKey = params.id;
      const existingRequest = inFlightSnapshotRequests.get(snapshotKey);

      const snapshotPromise = existingRequest ?? app.chatService.listThreadSnapshot(params.id);

      if (!existingRequest) {
        inFlightSnapshotRequests.set(snapshotKey, snapshotPromise);
      }

      try {
        const snapshot = await snapshotPromise;
        return { data: snapshot };
      } finally {
        if (!existingRequest) {
          inFlightSnapshotRequests.delete(snapshotKey);
        }
      }
    } catch (error) {
      return replyForThreadRouteError(reply, error, "Unable to load thread snapshot");
    }
  });

  app.get("/threads/:id/timeline", async (request, reply) => {
    try {
      const params = threadParams.parse(request.params);
      const timelineKey = params.id;
      const existingRequest = inFlightTimelineSnapshotRequests.get(timelineKey);

      const snapshotPromise = existingRequest ?? app.chatService.listThreadSnapshot(params.id).then((s) => s.timeline);

      if (!existingRequest) {
        inFlightTimelineSnapshotRequests.set(timelineKey, snapshotPromise);
      }

      try {
        const snapshot = await snapshotPromise;
        appendRuntimeDebugLog({
          source: "runtime.chats",
          message: "chat.backend.timelineSnapshot.response",
          data: {
            threadId: params.id,
            ...summarizeTimelineEnvelope(snapshot),
          },
        });
        return { data: snapshot };
      } finally {
        if (!existingRequest) {
          inFlightTimelineSnapshotRequests.delete(timelineKey);
        }
      }
    } catch (error) {
      return replyForThreadRouteError(reply, error, "Unable to load timeline");
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

  app.post("/threads/:id/plan/dismiss", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      await app.chatService.dismissPlan(params.id);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to dismiss plan";
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
      const events = await app.chatService.listEvents(params.id);
      return { data: events };
    } catch (error) {
      return replyForThreadRouteError(reply, error, "Unable to list events");
    }
  });

  app.get("/threads/:id/events/stream", async (request, reply) => {
    try {
      const params = threadParams.parse(request.params);
      await app.chatService.getThreadById(params.id).then((thread) => {
        if (!thread) {
          throw new ChatThreadNotFoundError();
        }
      });
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
      return replyForThreadRouteError(reply, error, "Unable to stream events");
    }
  });
}
