import type { FastifyInstance } from "fastify";

export async function registerResourceMonitorRoutes(app: FastifyInstance) {
  app.get("/resource-monitor/snapshot", async () => ({
    data: await app.resourceMonitorService.getSnapshot(),
  }));
}
