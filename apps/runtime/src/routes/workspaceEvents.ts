import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WorkspaceSyncEvent } from "@codesymphony/shared-types";

function writeSseHeaders(request: FastifyRequest, reply: FastifyReply) {
  const requestOrigin = Array.isArray(request.headers.origin)
    ? request.headers.origin[0]
    : request.headers.origin;
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  };

  if (requestOrigin) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
    headers.Vary = "Origin";
  }

  reply.raw.writeHead(200, headers);
}

function formatWorkspaceEvent(event: WorkspaceSyncEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function registerWorkspaceEventRoutes(app: FastifyInstance) {
  app.get("/workspace/events/stream", async (request, reply) => {
    writeSseHeaders(request, reply);
    reply.raw.write(": connected\n\n");

    const unsubscribe = app.workspaceEventHub.subscribe((event) => {
      reply.raw.write(formatWorkspaceEvent(event));
    });

    const keepAliveTimer = setInterval(() => {
      reply.raw.write(": keepalive\n\n");
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(keepAliveTimer);
      unsubscribe();
    });
  });
}
