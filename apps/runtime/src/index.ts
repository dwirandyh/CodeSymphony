import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { prisma } from "./db/prisma";
import { createEventHub } from "./events/eventHub";
import { runPromptStepWithClaude } from "./claude/sessionRunner";
import { createRunService } from "./services/runService";
import { registerWorkflowRoutes } from "./routes/workflows";
import { registerRunRoutes } from "./routes/runs";
import { registerApprovalRoutes } from "./routes/approvals";

declare module "fastify" {
  interface FastifyInstance {
    prisma: typeof prisma;
    eventHub: ReturnType<typeof createEventHub>;
    runService: ReturnType<typeof createRunService>;
  }
}

function createApp() {
  const app = Fastify({ logger: true });
  const eventHub = createEventHub(prisma);
  const runService = createRunService({
    prisma,
    eventHub,
    promptStepRunner: runPromptStepWithClaude,
  });

  app.decorate("prisma", prisma);
  app.decorate("eventHub", eventHub);
  app.decorate("runService", runService);

  app.register(cors, {
    origin: true,
  });

  app.get("/health", async () => ({ ok: true }));

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: "Validation error",
        details: error.flatten(),
      });
      return;
    }

    const fastifyError = error as FastifyError;
    if (typeof fastifyError.statusCode === "number" && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
      reply.code(fastifyError.statusCode).send({
        error: fastifyError.message,
      });
      return;
    }

    app.log.error(error);
    reply.code(500).send({
      error: "Internal server error",
    });
  });

  app.register(registerWorkflowRoutes, { prefix: "/api" });
  app.register(registerRunRoutes, { prefix: "/api" });
  app.register(registerApprovalRoutes, { prefix: "/api" });

  return app;
}

const host = process.env.RUNTIME_HOST ?? "127.0.0.1";
const port = Number(process.env.RUNTIME_PORT ?? "4321");

const app = createApp();

app
  .listen({ host, port })
  .then(() => {
    app.log.info(`Runtime listening on http://${host}:${port}`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
