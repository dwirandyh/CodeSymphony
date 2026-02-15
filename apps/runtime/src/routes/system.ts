import type { FastifyInstance } from "fastify";

export async function registerSystemRoutes(app: FastifyInstance) {
  app.post("/system/pick-directory", async (_request, reply) => {
    try {
      const result = await app.systemService.pickDirectory();
      return { data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to pick directory";
      return reply.code(400).send({ error: message });
    }
  });
}
