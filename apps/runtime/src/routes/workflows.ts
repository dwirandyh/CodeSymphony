import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createWorkflowService } from "../services/workflowService";

const paramsSchema = z.object({ id: z.string().min(1) });

export async function registerWorkflowRoutes(app: FastifyInstance) {
  const workflowService = createWorkflowService(app.prisma);

  app.get("/workflows", async () => {
    const workflows = await workflowService.list();
    return { data: workflows };
  });

  app.get("/workflows/:id", async (request, reply) => {
    const params = paramsSchema.parse(request.params);
    const workflow = await workflowService.getById(params.id);

    if (!workflow) {
      return reply.code(404).send({ error: "Workflow not found" });
    }

    return { data: workflow };
  });

  app.post("/workflows", async (request, reply) => {
    const workflow = await workflowService.create(request.body);
    return reply.code(201).send({ data: workflow });
  });

  app.put("/workflows/:id", async (request, reply) => {
    const params = paramsSchema.parse(request.params);
    const workflow = await workflowService.update(params.id, request.body);

    if (!workflow) {
      return reply.code(404).send({ error: "Workflow not found" });
    }

    return { data: workflow };
  });
}
