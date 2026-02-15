import type { PrismaClient } from "@prisma/client";
import { CreateWorkflowInputSchema, UpdateWorkflowInputSchema, type Workflow } from "@codesymphony/shared-types";
import { mapWorkflow } from "./mappers";

export function createWorkflowService(prisma: PrismaClient) {
  return {
    async list(): Promise<Workflow[]> {
      const workflows = await prisma.workflow.findMany({
        include: { steps: true },
        orderBy: { createdAt: "desc" },
      });

      return workflows.map(mapWorkflow);
    },

    async getById(id: string): Promise<Workflow | null> {
      const workflow = await prisma.workflow.findUnique({
        where: { id },
        include: { steps: true },
      });

      if (!workflow) {
        return null;
      }

      return mapWorkflow(workflow);
    },

    async create(input: unknown): Promise<Workflow> {
      const parsed = CreateWorkflowInputSchema.parse(input);

      const workflow = await prisma.workflow.create({
        data: {
          name: parsed.name,
          steps: {
            create: parsed.steps.map((step) => ({
              order: step.order,
              title: step.title,
              kind: step.kind,
              prompt: step.prompt ?? null,
            })),
          },
        },
        include: { steps: true },
      });

      return mapWorkflow(workflow);
    },

    async update(id: string, input: unknown): Promise<Workflow | null> {
      const parsed = UpdateWorkflowInputSchema.parse(input);

      const exists = await prisma.workflow.findUnique({ where: { id }, select: { id: true } });

      if (!exists) {
        return null;
      }

      const workflow = await prisma.$transaction(async (tx) => {
        await tx.workflowStep.deleteMany({ where: { workflowId: id } });

        return tx.workflow.update({
          where: { id },
          data: {
            name: parsed.name,
            steps: {
              create: parsed.steps.map((step) => ({
                order: step.order,
                title: step.title,
                kind: step.kind,
                prompt: step.prompt ?? null,
              })),
            },
          },
          include: { steps: true },
        });
      });

      return mapWorkflow(workflow);
    },
  };
}
