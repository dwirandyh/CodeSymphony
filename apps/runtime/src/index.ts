import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { prisma } from "./db/prisma";
import { createEventHub } from "./events/eventHub";
import { runClaudeWithStreaming } from "./claude/sessionRunner";
import { createRepositoryService } from "./services/repositoryService";
import { createWorktreeService } from "./services/worktreeService";
import { createChatService } from "./services/chatService";
import { createSystemService } from "./services/systemService";
import { createFileService } from "./services/fileService";
import { createTerminalService } from "./services/terminalService";
import { createLogService } from "./services/logService";
import { createFilesystemService } from "./services/filesystemService";
import { registerRepositoryRoutes } from "./routes/repositories";
import { registerChatRoutes } from "./routes/chats";
import { registerSystemRoutes } from "./routes/system";
import { registerTerminalRoutes } from "./routes/terminal";
import { registerLogRoutes } from "./routes/logs";
import { registerFilesystemRoutes } from "./routes/filesystem";
import { registerDebugRoutes } from "./routes/debug";

declare module "fastify" {
  interface FastifyInstance {
    prisma: typeof prisma;
    eventHub: ReturnType<typeof createEventHub>;
    repositoryService: ReturnType<typeof createRepositoryService>;
    worktreeService: ReturnType<typeof createWorktreeService>;
    chatService: ReturnType<typeof createChatService>;
    systemService: ReturnType<typeof createSystemService>;
    fileService: ReturnType<typeof createFileService>;
    terminalService: ReturnType<typeof createTerminalService>;
    logService: ReturnType<typeof createLogService>;
    filesystemService: ReturnType<typeof createFilesystemService>;
  }
}

function createApp() {
  const app = Fastify({ logger: true });
  const eventHub = createEventHub(prisma);
  const repositoryService = createRepositoryService(prisma);
  const worktreeService = createWorktreeService(prisma);
  const systemService = createSystemService();
  const fileService = createFileService();
  const terminalService = createTerminalService();
  const logService = createLogService();
  const filesystemService = createFilesystemService();
  const chatService = createChatService({
    prisma,
    eventHub,
    claudeRunner: runClaudeWithStreaming,
    logService,
  });

  app.decorate("prisma", prisma);
  app.decorate("eventHub", eventHub);
  app.decorate("repositoryService", repositoryService);
  app.decorate("worktreeService", worktreeService);
  app.decorate("chatService", chatService);
  app.decorate("systemService", systemService);
  app.decorate("fileService", fileService);
  app.decorate("terminalService", terminalService);
  app.decorate("logService", logService);
  app.decorate("filesystemService", filesystemService);

  app.register(cors, {
    origin: true,
  });

  app.register(websocket);

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
  app.register(registerTerminalRoutes, { prefix: "/api" });
  app.register(registerLogRoutes, { prefix: "/api" });
  app.register(registerFilesystemRoutes, { prefix: "/api" });
  app.register(registerDebugRoutes, { prefix: "/api" });

  logService.log("info", "runtime", "CodeSymphony runtime started");

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
