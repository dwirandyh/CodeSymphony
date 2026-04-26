import type { FastifyInstance } from "fastify";
import type {
  ChatEvent,
  ChatThreadSnapshot,
  ChatThreadStatusSnapshot,
  ChatTimelineSnapshot,
  CliAgent,
} from "@codesymphony/shared-types";
import { CliAgentSchema } from "@codesymphony/shared-types";
import { z } from "zod";
import { appendRuntimeDebugLog } from "./debug.js";
import { areLikelySameFsPath } from "../services/repositoryService.js";

const repositoryParams = z.object({ id: z.string().min(1) });
const worktreeParams = z.object({ id: z.string().min(1) });
const threadParams = z.object({ id: z.string().min(1) });
const streamEventQuery = z.object({ afterIdx: z.string().optional() }).strict();
const timelineQuery = z.object({ includeCollections: z.enum(["0", "1"]).optional() }).strict();
const slashCommandQuery = z.object({
  agent: CliAgentSchema.optional(),
}).strict();
const inFlightSnapshotRequests = new Map<string, Promise<ChatThreadSnapshot>>();
const inFlightStatusSnapshotRequests = new Map<string, Promise<ChatThreadStatusSnapshot>>();
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

function summarizeTimelineEnvelope(snapshot: ChatTimelineSnapshot) {
  return {
    timelineItemsCount: snapshot.timelineItems.length,
    newestSeq: snapshot.newestSeq,
    newestIdx: snapshot.newestIdx,
    messagesCount: snapshot.messages.length,
    eventsCount: snapshot.events.length,
  };
}

function respondForChatRouteError(reply: { code: (statusCode: number) => { send: (payload: { error: string }) => unknown } }, error: unknown, fallbackMessage: string) {
  const message = error instanceof Error ? error.message : fallbackMessage;
  if (message === "Chat thread not found" || message === "Thread not found") {
    return reply.code(404).send({ error: message });
  }
  if (message === "Worktree not found") {
    return reply.code(404).send({ error: message });
  }
  if (message === "Selected model provider not found") {
    return reply.code(404).send({ error: message });
  }
  if (message === "Cannot delete a thread while assistant is processing") {
    return reply.code(409).send({ error: message });
  }
  if (
    message === "Queued message not found"
    || message === "Chat thread not found"
    || message === "Thread not found"
  ) {
    return reply.code(404).send({ error: message });
  }
  if (
    message === "Cannot dispatch queued messages while the assistant is waiting for approval or review"
    || message === "Cannot edit a queued message while it is dispatching"
  ) {
    return reply.code(409).send({ error: message });
  }
  if (
    message === "Cannot change agent or model while assistant is processing"
    || message === "Cannot change agent or model after the thread has messages"
  ) {
    return reply.code(409).send({ error: message });
  }
  return reply.code(400).send({ error: message });
}

async function emitThreadWorkspaceEvent(
  app: FastifyInstance,
  type: "thread.created" | "thread.updated" | "thread.deleted",
  thread: { id: string; worktreeId: string },
): Promise<void> {
  const worktree = await app.worktreeService.getById(thread.worktreeId);
  app.workspaceEventHub.emit(type, {
    repositoryId: worktree?.repositoryId ?? null,
    worktreeId: thread.worktreeId,
    threadId: thread.id,
  });
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

  app.get("/worktrees/:id/slash-commands", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const query = slashCommandQuery.parse(request.query);
    const agent: CliAgent = query.agent ?? "claude";

    try {
      const slashCommands = await app.chatService.listSlashCommands(params.id, agent);
      return { data: slashCommands };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list slash commands";
      if (message === "Worktree not found") {
        return reply.code(404).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/worktrees/:id/threads", async (request, reply) => {
    const params = worktreeParams.parse(request.params);

    try {
      const thread = await app.chatService.createThread(params.id, request.body);
      await emitThreadWorkspaceEvent(app, "thread.created", thread);
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

      if (!rootWorktree) {
        return reply.code(400).send({ error: "Repository root worktree is not available" });
      }

      const targetWorktree = rootWorktree;

      app.log.info(
        {
          repositoryId: repository.id,
          repositoryRootPath: repository.rootPath,
          targetWorktreeId: targetWorktree.id,
          targetWorktreePath: targetWorktree.path,
          targetWorktreeBranch: targetWorktree.branch,
          targetReason: "root-worktree",
        },
        "create thread for repository",
      );

      const thread = await app.chatService.createThread(targetWorktree.id, request.body);
      await emitThreadWorkspaceEvent(app, "thread.created", thread);
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
      await emitThreadWorkspaceEvent(app, "thread.updated", thread);
      return { data: thread };
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to rename thread title");
    }
  });

  app.patch("/threads/:id/mode", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      const thread = await app.chatService.updateThreadMode(params.id, request.body);
      await emitThreadWorkspaceEvent(app, "thread.updated", thread);
      return { data: thread };
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to update thread mode");
    }
  });

  app.patch("/threads/:id/permission-mode", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      const thread = await app.chatService.updateThreadPermissionMode(params.id, request.body);
      await emitThreadWorkspaceEvent(app, "thread.updated", thread);
      return { data: thread };
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to update thread permission mode");
    }
  });

  app.patch("/threads/:id/agent-selection", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      const thread = await app.chatService.updateThreadAgentSelection(params.id, request.body);
      await emitThreadWorkspaceEvent(app, "thread.updated", thread);
      return { data: thread };
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to update thread agent selection");
    }
  });

  app.delete("/threads/:id", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      const thread = await app.chatService.getThreadById(params.id);
      if (!thread) {
        return reply.code(404).send({ error: "Thread not found" });
      }
      await app.chatService.deleteThread(params.id);
      await emitThreadWorkspaceEvent(app, "thread.deleted", thread);
      return reply.code(204).send();
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to delete thread");
    }
  });

  app.get("/threads/:id/messages", async (request, reply) => {
    try {
      const params = threadParams.parse(request.params);
      const messages = await app.chatService.listMessages(params.id);
      return { data: messages };
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to list messages");
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
      return respondForChatRouteError(reply, error, "Unable to load thread snapshot");
    }
  });

  app.get("/threads/:id/status-snapshot", async (request, reply) => {
    try {
      const params = threadParams.parse(request.params);
      const snapshotKey = params.id;
      const existingRequest = inFlightStatusSnapshotRequests.get(snapshotKey);

      const snapshotPromise = existingRequest ?? app.chatService.listThreadStatusSnapshot(params.id);

      if (!existingRequest) {
        inFlightStatusSnapshotRequests.set(snapshotKey, snapshotPromise);
      }

      try {
        const snapshot = await snapshotPromise;
        return { data: snapshot };
      } finally {
        if (!existingRequest) {
          inFlightStatusSnapshotRequests.delete(snapshotKey);
        }
      }
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to load thread status snapshot");
    }
  });

  app.get("/threads/:id/timeline", async (request, reply) => {
    try {
      const params = threadParams.parse(request.params);
      const query = timelineQuery.parse(request.query);
      const includeCollections = query.includeCollections !== "0";
      const timelineKey = `${params.id}:${includeCollections ? "full" : "display"}`;
      const existingRequest = inFlightTimelineSnapshotRequests.get(timelineKey);

      const snapshotPromise = existingRequest ?? app.chatService.listThreadSnapshot(params.id, {
        includeCollections,
      }).then((s) => s.timeline);

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
            includeCollections,
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
      return respondForChatRouteError(reply, error, "Unable to load timeline");
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

  app.get("/threads/:id/queue", async (request, reply) => {
    try {
      const params = threadParams.parse(request.params);
      const queuedMessages = await app.chatService.listQueuedMessages(params.id);
      return { data: queuedMessages };
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to list queued messages");
    }
  });

  app.post("/threads/:id/queue", { bodyLimit: 15 * 1024 * 1024 }, async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      const queuedMessage = await app.chatService.queueMessage(params.id, request.body);
      return reply.code(201).send({ data: queuedMessage });
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to queue message");
    }
  });

  app.delete("/threads/:id/queue/:queueMessageId", async (request, reply) => {
    const params = z.object({
      id: z.string().min(1),
      queueMessageId: z.string().min(1),
    }).parse(request.params);

    try {
      await app.chatService.deleteQueuedMessage(params.id, params.queueMessageId);
      return reply.code(204).send();
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to delete queued message");
    }
  });

  app.patch("/threads/:id/queue/:queueMessageId", async (request, reply) => {
    const params = z.object({
      id: z.string().min(1),
      queueMessageId: z.string().min(1),
    }).parse(request.params);

    try {
      const queuedMessage = await app.chatService.updateQueuedMessage(params.id, params.queueMessageId, request.body);
      return { data: queuedMessage };
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to update queued message");
    }
  });

  app.post("/threads/:id/queue/:queueMessageId/dispatch", async (request, reply) => {
    const params = z.object({
      id: z.string().min(1),
      queueMessageId: z.string().min(1),
    }).parse(request.params);

    try {
      const queuedMessage = await app.chatService.requestQueuedMessageDispatch(params.id, params.queueMessageId);
      return { data: queuedMessage };
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to request queued message dispatch");
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

  app.post("/threads/:id/plan/dismiss", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      await app.chatService.dismissPlan(params.id, request.body ?? {});
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to dismiss plan";
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
      const events = await app.chatService.listEvents(params.id);
      return { data: events };
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to list events");
    }
  });

  app.get("/threads/:id/events/stream", async (request, reply) => {
    try {
      const params = threadParams.parse(request.params);
      const query = streamEventQuery.parse(request.query);
      await app.chatService.getThreadById(params.id).then((thread) => {
        if (!thread) {
          throw new Error("Chat thread not found");
        }
      });
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

      let closed = false;
      let historyFlushed = false;
      let unsubscribe: (() => void) | null = null;
      const bufferedEvents: ChatEvent[] = [];
      const heartbeat = setInterval(() => {
        if (!closed) {
          reply.raw.write(": ping\n\n");
        }
      }, 15000);

      const cleanup = () => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        appendRuntimeDebugLog({
          source: "runtime.chats",
          message: "chat.backend.sse.closed",
          data: {
            requestId: streamRequestId,
            threadId: params.id,
            bufferedCountAtClose: bufferedEvents.length,
          },
        });
      };

      unsubscribe = app.eventHub.subscribe(params.id, (event) => {
        if (closed) {
          return;
        }
        if (typeof startCursor === "number" && event.idx <= startCursor) {
          return;
        }
        if (!historyFlushed) {
          bufferedEvents.push(event);
          return;
        }
        reply.raw.write(formatSseEvent(event));
      });

      try {
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
            bufferedCountBeforeFlush: bufferedEvents.length,
          },
        });
        const seenIdx = new Set<number>();
        for (const event of history) {
          seenIdx.add(event.idx);
          reply.raw.write(formatSseEvent(event));
        }

        let bufferedDeliveredCount = 0;
        for (const event of bufferedEvents) {
          if (!seenIdx.has(event.idx)) {
            reply.raw.write(formatSseEvent(event));
            bufferedDeliveredCount += 1;
          }
        }
        historyFlushed = true;
        appendRuntimeDebugLog({
          source: "runtime.chats",
          message: "chat.backend.sse.bufferFlushed",
          data: {
            requestId: streamRequestId,
            threadId: params.id,
            bufferedCountBeforeFlush: bufferedEvents.length,
            bufferedDeliveredCount,
          },
        });

        request.raw.on("close", cleanup);
        reply.raw.on("error", cleanup);
        reply.raw.on("close", cleanup);

        await new Promise<void>((resolve) => {
          request.raw.on("close", () => resolve());
        });

        return reply;
      } catch (error) {
        cleanup();
        throw error;
      }
    } catch (error) {
      return respondForChatRouteError(reply, error, "Unable to stream events");
    }
  });
}
