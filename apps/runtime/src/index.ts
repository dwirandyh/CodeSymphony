import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { prisma } from "./db/prisma";
import { createEventHub } from "./events/eventHub";
import { runClaudeWithStreaming } from "./claude/sessionRunner";
import { createRepositoryService } from "./services/repositoryService";
import { createWorktreeService } from "./services/worktreeService";
import { createChatService } from "./services/chatService";
import { createSystemService } from "./services/systemService";
import { registerRepositoryRoutes } from "./routes/repositories";
import { registerChatRoutes } from "./routes/chats";
import { registerSystemRoutes } from "./routes/system";

declare module "fastify" {
  interface FastifyInstance {
    prisma: typeof prisma;
    eventHub: ReturnType<typeof createEventHub>;
    repositoryService: ReturnType<typeof createRepositoryService>;
    worktreeService: ReturnType<typeof createWorktreeService>;
    chatService: ReturnType<typeof createChatService>;
    systemService: ReturnType<typeof createSystemService>;
  }
}

function createApp() {
  const app = Fastify({ logger: true });
  const eventHub = createEventHub(prisma);
  const repositoryService = createRepositoryService(prisma);
  const worktreeService = createWorktreeService(prisma);
  const systemService = createSystemService();
  const chatService = createChatService({
    prisma,
    eventHub,
    claudeRunner: runClaudeWithStreaming,
  });

  app.decorate("prisma", prisma);
  app.decorate("eventHub", eventHub);
  app.decorate("repositoryService", repositoryService);
  app.decorate("worktreeService", worktreeService);
  app.decorate("chatService", chatService);
  app.decorate("systemService", systemService);

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

  app.register(registerRepositoryRoutes, { prefix: "/api" });
  app.register(registerChatRoutes, { prefix: "/api" });
  app.register(registerSystemRoutes, { prefix: "/api" });

  return app;
}

const host = process.env.RUNTIME_HOST ?? "0.0.0.0";
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
