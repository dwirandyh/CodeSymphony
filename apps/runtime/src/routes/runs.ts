import type { FastifyInstance } from "fastify";
import { z } from "zod";

const runIdParams = z.object({ runId: z.string().min(1) });
const eventQuery = z.object({ afterIdx: z.string().optional() });

export async function registerRunRoutes(app: FastifyInstance) {
  app.get("/runs", async () => {
    const runs = await app.runService.listRuns();
    return { data: runs };
  });

  app.get("/runs/:runId", async (request, reply) => {
    const params = runIdParams.parse(request.params);
    const run = await app.runService.getRunById(params.runId);

    if (!run) {
      return reply.code(404).send({ error: "Run not found" });
    }

    return { data: run };
  });

  app.post("/runs", async (request, reply) => {
    try {
      const run = await app.runService.createRun(request.body);
      return reply.code(201).send({ data: run });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create run";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/runs/:runId/events", async (request, reply) => {
    const params = runIdParams.parse(request.params);
    const query = eventQuery.parse(request.query);
    const afterIdx = query.afterIdx ? Number(query.afterIdx) : undefined;

    const events = await app.eventHub.list(params.runId, Number.isFinite(afterIdx) ? afterIdx : undefined);
    return { data: events };
  });

  app.get("/runs/:runId/events/stream", async (request, reply) => {
    const params = runIdParams.parse(request.params);

    const requestOrigin = request.headers.origin;

    if (requestOrigin) {
      reply.raw.setHeader("Access-Control-Allow-Origin", requestOrigin);
      reply.raw.setHeader("Vary", "Origin");
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");

    const history = await app.eventHub.list(params.runId);
    for (const event of history) {
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const unsubscribe = app.eventHub.subscribe(params.runId, (event) => {
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
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
