import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { WorkspaceLiveResourceEvent } from "@codesymphony/shared-types";
import { isUnavailableWorktreeErrorMessage } from "../services/worktreeService.js";

const resourceIdParams = z.object({
  id: z.string().trim().min(1),
});

const resourceStreamQuery = z.object({
  afterSeq: z.string().optional(),
});

function parseLiveSeq(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

export function parseWorkspaceLiveStartCursor(
  afterSeq: string | undefined,
  lastEventIdHeader: string | string[] | undefined,
): number | undefined {
  const queryCursor = parseLiveSeq(afterSeq);
  const headerValue = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
  const headerCursor = parseLiveSeq(headerValue);

  if (typeof queryCursor === "number" && typeof headerCursor === "number") {
    return Math.max(queryCursor, headerCursor);
  }

  return queryCursor ?? headerCursor;
}

export function formatWorkspaceLiveEvent(event: WorkspaceLiveResourceEvent): string {
  return `id: ${event.seq}\nevent: snapshot\ndata: ${JSON.stringify(event)}\n\n`;
}

function formatWorkspaceLiveHeartbeat(): string {
  return `event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`;
}

function writeLiveSseHeaders(request: FastifyRequest, reply: FastifyReply) {
  const requestOrigin = Array.isArray(request.headers.origin)
    ? request.headers.origin[0]
    : request.headers.origin;

  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");

  if (requestOrigin) {
    reply.raw.setHeader("Access-Control-Allow-Origin", requestOrigin);
    reply.raw.setHeader("Vary", "Origin");
  }
}

function respondForWorkspaceLiveRouteError(reply: FastifyReply, error: unknown, fallbackMessage: string) {
  const message = error instanceof Error ? error.message : fallbackMessage;
  if (
    message === "Repository not found"
    || message === "Automation not found"
    || message === "Worktree not found"
  ) {
    return reply.code(404).send({ error: message });
  }

  if (isUnavailableWorktreeErrorMessage(message)) {
    return reply.code(409).send({ error: message });
  }

  return reply.code(400).send({ error: message });
}

async function streamWorkspaceResource(params: {
  app: FastifyInstance;
  request: FastifyRequest;
  reply: FastifyReply;
  afterSeq: number | undefined;
  listEvents: (afterSeq?: number) => Promise<WorkspaceLiveResourceEvent[]>;
  subscribe: (listener: (event: WorkspaceLiveResourceEvent) => void) => () => void;
  fallbackMessage: string;
}) {
  const { request, reply, afterSeq, listEvents, subscribe } = params;
  writeLiveSseHeaders(request, reply);

  let closed = false;
  let historyFlushed = false;
  let unsubscribe: (() => void) | null = null;
  const bufferedEvents: WorkspaceLiveResourceEvent[] = [];

  const heartbeat = setInterval(() => {
    if (!closed) {
      reply.raw.write(formatWorkspaceLiveHeartbeat());
    }
  }, 15_000);

  const cleanup = () => {
    if (closed) {
      return;
    }

    closed = true;
    clearInterval(heartbeat);
    unsubscribe?.();
  };

  unsubscribe = subscribe((event) => {
    if (closed) {
      return;
    }
    if (typeof afterSeq === "number" && event.seq <= afterSeq) {
      return;
    }
    if (!historyFlushed) {
      bufferedEvents.push(event);
      return;
    }
    reply.raw.write(formatWorkspaceLiveEvent(event));
  });

  try {
    const history = await listEvents(afterSeq);
    const seenSeq = new Set<number>();

    for (const event of history) {
      seenSeq.add(event.seq);
      reply.raw.write(formatWorkspaceLiveEvent(event));
    }

    for (const event of bufferedEvents) {
      if (!seenSeq.has(event.seq)) {
        reply.raw.write(formatWorkspaceLiveEvent(event));
      }
    }

    historyFlushed = true;
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
}

export async function registerWorkspaceLiveResourceRoutes(app: FastifyInstance) {
  app.get("/live/worktrees/:id/git-status/stream", async (request, reply) => {
    try {
      const params = resourceIdParams.parse(request.params);
      const query = resourceStreamQuery.parse(request.query);
      const startCursor = parseWorkspaceLiveStartCursor(query.afterSeq, request.headers["last-event-id"]);
      return await streamWorkspaceResource({
        app,
        request,
        reply,
        afterSeq: startCursor,
        fallbackMessage: "Unable to stream git status",
        listEvents: (afterSeq) => app.workspaceLiveUpdateService.listGitStatusEvents(params.id, afterSeq),
        subscribe: (listener) => app.workspaceLiveUpdateService.subscribeToGitStatus(params.id, listener),
      });
    } catch (error) {
      return respondForWorkspaceLiveRouteError(reply, error, "Unable to stream git status");
    }
  });

  app.get("/live/repositories/:id/branches/stream", async (request, reply) => {
    try {
      const params = resourceIdParams.parse(request.params);
      const query = resourceStreamQuery.parse(request.query);
      const startCursor = parseWorkspaceLiveStartCursor(query.afterSeq, request.headers["last-event-id"]);
      return await streamWorkspaceResource({
        app,
        request,
        reply,
        afterSeq: startCursor,
        fallbackMessage: "Unable to stream branches",
        listEvents: (afterSeq) => app.workspaceLiveUpdateService.listRepositoryBranchesEvents(params.id, afterSeq),
        subscribe: (listener) => app.workspaceLiveUpdateService.subscribeToRepositoryBranches(params.id, listener),
      });
    } catch (error) {
      return respondForWorkspaceLiveRouteError(reply, error, "Unable to stream branches");
    }
  });

  app.get("/live/repositories/:id/reviews/stream", async (request, reply) => {
    try {
      const params = resourceIdParams.parse(request.params);
      const query = resourceStreamQuery.parse(request.query);
      const startCursor = parseWorkspaceLiveStartCursor(query.afterSeq, request.headers["last-event-id"]);
      return await streamWorkspaceResource({
        app,
        request,
        reply,
        afterSeq: startCursor,
        fallbackMessage: "Unable to stream reviews",
        listEvents: (afterSeq) => app.workspaceLiveUpdateService.listRepositoryReviewsEvents(params.id, afterSeq),
        subscribe: (listener) => app.workspaceLiveUpdateService.subscribeToRepositoryReviews(params.id, listener),
      });
    } catch (error) {
      return respondForWorkspaceLiveRouteError(reply, error, "Unable to stream reviews");
    }
  });

  app.get("/live/automations/:id/runs/stream", async (request, reply) => {
    try {
      const params = resourceIdParams.parse(request.params);
      const query = resourceStreamQuery.parse(request.query);
      const startCursor = parseWorkspaceLiveStartCursor(query.afterSeq, request.headers["last-event-id"]);
      return await streamWorkspaceResource({
        app,
        request,
        reply,
        afterSeq: startCursor,
        fallbackMessage: "Unable to stream automation runs",
        listEvents: (afterSeq) => app.workspaceLiveUpdateService.listAutomationRunsEvents(params.id, afterSeq),
        subscribe: (listener) => app.workspaceLiveUpdateService.subscribeToAutomationRuns(params.id, listener),
      });
    } catch (error) {
      return respondForWorkspaceLiveRouteError(reply, error, "Unable to stream automation runs");
    }
  });
}
