import { beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { PrismaClient } from "@prisma/client";
import { createEventHub } from "../src/events/eventHub";
import { createRunService } from "../src/services/runService";
import { registerWorkflowRoutes } from "../src/routes/workflows";
import { registerRunRoutes } from "../src/routes/runs";
import { registerApprovalRoutes } from "../src/routes/approvals";

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "file:./test.db",
    },
  },
});

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    eventHub: ReturnType<typeof createEventHub>;
    runService: ReturnType<typeof createRunService>;
  }
}

function makeApp() {
  const app = Fastify();
  const eventHub = createEventHub(prisma);
  const runService = createRunService({
    prisma,
    eventHub,
    promptStepRunner: async ({ prompt }) => ({
      output: `output:${prompt}`,
      sessionId: null,
    }),
  });

  app.decorate("prisma", prisma);
  app.decorate("eventHub", eventHub);
  app.decorate("runService", runService);

  app.register(cors, { origin: true });
  app.register(registerWorkflowRoutes, { prefix: "/api" });
  app.register(registerRunRoutes, { prefix: "/api" });
  app.register(registerApprovalRoutes, { prefix: "/api" });

  return app;
}

describe("runtime routes", () => {
  beforeEach(async () => {
    await prisma.runEvent.deleteMany();
    await prisma.approvalDecision.deleteMany();
    await prisma.runStep.deleteMany();
    await prisma.run.deleteMany();
    await prisma.workflowStep.deleteMany();
    await prisma.workflow.deleteMany();
  });

  it("creates workflow and run through API", async () => {
    const app = makeApp();

    const createdWorkflow = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: {
        name: "api flow",
        steps: [
          { order: 0, title: "prompt", kind: "prompt", prompt: "hello" },
          { order: 1, title: "approval", kind: "approval", prompt: null },
        ],
      },
    });

    expect(createdWorkflow.statusCode).toBe(201);

    const workflowPayload = createdWorkflow.json() as { data: { id: string } };

    const runResponse = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        workflowId: workflowPayload.data.id,
      },
    });

    expect(runResponse.statusCode).toBe(201);

    const runPayload = runResponse.json() as { data: { id: string } };

    const eventsResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${runPayload.data.id}/events`,
    });

    expect(eventsResponse.statusCode).toBe(200);
    const events = eventsResponse.json() as { data: unknown[] };
    expect(Array.isArray(events.data)).toBe(true);

    await app.close();
  });
});
