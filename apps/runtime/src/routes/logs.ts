import type { FastifyInstance } from "fastify";

export async function registerLogRoutes(app: FastifyInstance) {
    app.get("/logs", async (request) => {
        const query = request.query as Record<string, string>;
        const since = query.since || undefined;
        return { data: app.logService.getEntries(since) };
    });

    app.get("/logs/stream", async (request, reply) => {
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });

        reply.raw.write(":\n\n");

        const unsubscribe = app.logService.subscribe((entry) => {
            reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
        });

        request.raw.on("close", () => {
            unsubscribe();
        });
    });
}
