import type { FastifyInstance } from "fastify";
import { z } from "zod";

const runIdParams = z.object({ runId: z.string().min(1) });

export async function registerApprovalRoutes(app: FastifyInstance) {
  app.post("/runs/:runId/approval", async (request, reply) => {
    const params = runIdParams.parse(request.params);

    try {
      const approval = await app.runService.decideApproval(params.runId, request.body);
      return { data: approval };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to process approval";
      return reply.code(400).send({ error: message });
    }
  });
}
