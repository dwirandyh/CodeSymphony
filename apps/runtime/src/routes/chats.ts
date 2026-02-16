import type { FastifyInstance } from "fastify";
import type { ChatEvent } from "@codesymphony/shared-types";
import { z } from "zod";

const worktreeParams = z.object({ id: z.string().min(1) });
const threadParams = z.object({ id: z.string().min(1) });
const eventQuery = z.object({ afterIdx: z.string().optional() });

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

  app.get("/threads/:id", async (request, reply) => {
    const params = threadParams.parse(request.params);
    const thread = await app.chatService.getThreadById(params.id);

    if (!thread) {
      return reply.code(404).send({ error: "Thread not found" });
    }

    return { data: thread };
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
    const params = threadParams.parse(request.params);

    try {
      const messages = await app.chatService.listMessages(params.id);
      return { data: messages };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list messages";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/threads/:id/messages", async (request, reply) => {
    const params = threadParams.parse(request.params);

    try {
      const message = await app.chatService.sendMessage(params.id, request.body);
      return reply.code(201).send({ data: message });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to send message";
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
    const params = threadParams.parse(request.params);
    const query = eventQuery.parse(request.query);
    const afterIdx = query.afterIdx ? Number(query.afterIdx) : undefined;

    try {
      const events = await app.chatService.listEvents(params.id, Number.isFinite(afterIdx) ? afterIdx : undefined);
      return { data: events };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list events";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/threads/:id/events/stream", async (request, reply) => {
    const params = threadParams.parse(request.params);
    const query = eventQuery.parse(request.query);
    const startCursor = parseStreamStartCursor(query.afterIdx, request.headers["last-event-id"]);

    const requestOrigin = request.headers.origin;

    if (requestOrigin) {
      reply.raw.setHeader("Access-Control-Allow-Origin", requestOrigin);
      reply.raw.setHeader("Vary", "Origin");
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");

    const history = await app.chatService.listEvents(params.id, startCursor);
    for (const event of history) {
      reply.raw.write(formatSseEvent(event));
    }

    const unsubscribe = app.eventHub.subscribe(params.id, (event) => {
      reply.raw.write(formatSseEvent(event));
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 15000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    await new Promise<void>((resolve) => {
      request.raw.on("close", () => resolve());
    });

    return reply;
  });
}
