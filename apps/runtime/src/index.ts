import path from "node:path";
import { existsSync } from "node:fs";
import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { prisma } from "./db/prisma.js";
import { assertDatabaseReady, DatabaseNotReadyError } from "./db/databaseReadiness.js";
import { createEventHub } from "./events/eventHub.js";
import { createWorkspaceEventHub } from "./events/workspaceEventHub.js";
import { runClaudeWithStreaming } from "./claude/sessionRunner.js";
import { runCodexWithStreaming } from "./codex/sessionRunner.js";
import { runCursorWithStreaming } from "./cursor/sessionRunner.js";
import { runOpencodeWithStreaming } from "./opencode/sessionRunner.js";
import { createRepositoryService } from "./services/repositoryService.js";
import { createWorktreeService } from "./services/worktreeService.js";
import { createChatService } from "./services/chat/index.js";
import { createSystemService } from "./services/systemService.js";
import { createFileService } from "./services/fileService.js";
import { createTerminalService } from "./services/terminalService.js";
import { createLogService } from "./services/logService.js";
import { createFilesystemService } from "./services/filesystemService.js";
import { createScriptStreamService } from "./services/scriptStreamService.js";
import { createModelProviderService } from "./services/modelProviderService.js";
import { createReviewService } from "./services/reviewService.js";
import { createDeviceService } from "./services/deviceService.js";
import { createWorktreeDeletionService } from "./services/worktreeDeletionService.js";
import { createAutomationService } from "./services/automationService.js";
import { registerRepositoryRoutes } from "./routes/repositories.js";
import { registerChatRoutes } from "./routes/chats.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerTerminalRoutes } from "./routes/terminal.js";
import { registerLogRoutes } from "./routes/logs.js";
import { registerFilesystemRoutes } from "./routes/filesystem.js";
import { registerDebugRoutes, resolveDatabaseInfo } from "./routes/debug.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerWorkspaceEventRoutes } from "./routes/workspaceEvents.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerAutomationRoutes } from "./routes/automations.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: typeof prisma;
    eventHub: ReturnType<typeof createEventHub>;
    workspaceEventHub: ReturnType<typeof createWorkspaceEventHub>;
    repositoryService: ReturnType<typeof createRepositoryService>;
    worktreeService: ReturnType<typeof createWorktreeService>;
    chatService: ReturnType<typeof createChatService>;
    systemService: ReturnType<typeof createSystemService>;
    fileService: ReturnType<typeof createFileService>;
    terminalService: ReturnType<typeof createTerminalService>;
    logService: ReturnType<typeof createLogService>;
    filesystemService: ReturnType<typeof createFilesystemService>;
    scriptStreamService: ReturnType<typeof createScriptStreamService>;
    modelProviderService: ReturnType<typeof createModelProviderService>;
    reviewService: ReturnType<typeof createReviewService>;
    deviceService: ReturnType<typeof createDeviceService>;
    worktreeDeletionService: ReturnType<typeof createWorktreeDeletionService>;
    automationService: ReturnType<typeof createAutomationService>;
  }
}

function createApp() {
  const app = Fastify({ logger: true });
  const eventHub = createEventHub(prisma);
  const workspaceEventHub = createWorkspaceEventHub();
  const repositoryService = createRepositoryService(prisma);
  const worktreeService = createWorktreeService(prisma, { workspaceEventHub });
  const systemService = createSystemService();
  const fileService = createFileService();
  const terminalService = createTerminalService();
  const logService = createLogService();
  const filesystemService = createFilesystemService();
  const scriptStreamService = createScriptStreamService();
  const modelProviderService = createModelProviderService(prisma);
  const reviewService = createReviewService(prisma);
  const deviceService = createDeviceService(logService);
  const worktreeDeletionService = createWorktreeDeletionService({
    prisma,
    workspaceEventHub,
    worktreeService,
    logService,
  });
  const chatService = createChatService({
    prisma,
    eventHub,
    workspaceEventHub,
    claudeRunner: runClaudeWithStreaming,
    codexRunner: runCodexWithStreaming,
    cursorRunner: runCursorWithStreaming,
    opencodeRunner: runOpencodeWithStreaming,
    logService,
    modelProviderService,
  });
  const automationService = createAutomationService({
    prisma,
    eventHub,
    workspaceEventHub,
    worktreeService,
    chatService,
  });

  app.decorate("prisma", prisma);
  app.decorate("eventHub", eventHub);
  app.decorate("workspaceEventHub", workspaceEventHub);
  app.decorate("repositoryService", repositoryService);
  app.decorate("worktreeService", worktreeService);
  app.decorate("chatService", chatService);
  app.decorate("systemService", systemService);
  app.decorate("fileService", fileService);
  app.decorate("terminalService", terminalService);
  app.decorate("logService", logService);
  app.decorate("filesystemService", filesystemService);
  app.decorate("scriptStreamService", scriptStreamService);
  app.decorate("modelProviderService", modelProviderService);
  app.decorate("reviewService", reviewService);
  app.decorate("deviceService", deviceService);
  app.decorate("worktreeDeletionService", worktreeDeletionService);
  app.decorate("automationService", automationService);

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
  app.register(registerModelRoutes, { prefix: "/api" });
  app.register(registerWorkspaceEventRoutes, { prefix: "/api" });
  app.register(registerDeviceRoutes, { prefix: "/api" });
  app.register(registerAutomationRoutes, { prefix: "/api" });

  app.addHook("onClose", async () => {
    automationService.dispose();
    await deviceService.stopAll();
  });

  // Serve web frontend static files when WEB_DIST_PATH is set (production)
  const webDistPath = process.env.WEB_DIST_PATH;
  if (webDistPath) {
    const resolvedDistPath = path.resolve(webDistPath);
    if (existsSync(resolvedDistPath)) {
      app.register(fastifyStatic, {
        root: resolvedDistPath,
        setHeaders(res, filePath) {
          if (filePath.includes("/assets/")) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          } else {
            res.setHeader("Cache-Control", "no-cache");
          }
        },
      });

      app.setNotFoundHandler((request, reply) => {
        const pathname = request.url.split("?")[0] ?? request.url;
        const lastPathSegment = pathname.split("/").filter(Boolean).pop() ?? "";
        const looksLikeStaticAsset = lastPathSegment.includes(".");

        // API misses → JSON 404
        if (
          request.url.startsWith("/api/") ||
          request.url === "/health" ||
          looksLikeStaticAsset ||
          request.method !== "GET" ||
          request.headers.accept?.includes("application/json")
        ) {
          reply.code(404).send({ error: "Not found" });
          return;
        }
        // SPA fallback → serve index.html
        reply.sendFile("index.html");
      });
    } else {
      app.log.warn(`WEB_DIST_PATH is set but path does not exist: ${resolvedDistPath}`);
    }
  }

  logService.log("info", "runtime", "CodeSymphony runtime started");

  return app;
}

async function main() {
  try {
    // Run Prisma migrations in production before starting the server
    if (process.env.NODE_ENV === "production") {
      const { runPrismaMigrations } = await import("./migrate.js");
      runPrismaMigrations();
    }

    await assertDatabaseReady(prisma);

    const host = process.env.RUNTIME_HOST ?? "0.0.0.0";
    const port = Number(process.env.RUNTIME_PORT ?? "4331");

    const app = createApp();
    const recoveredStuckThreadCount = await app.chatService.recoverStuckThreads();
    const recoveredPendingCreationCount = await app.worktreeService.recoverPendingCreations();
    const recoveredPendingDeletionCount = await app.worktreeDeletionService.recoverPendingDeletions();
    const recoveredAutomationRunCount = await app.automationService.recoverInFlightRuns();
    await app.automationService.dispatchDueAutomations();
    app.automationService.startScheduler();

    const database = resolveDatabaseInfo(process.env.DATABASE_URL);

    await app.listen({ host, port });
    app.log.info({
      databaseUrl: database.urlPreview,
      databasePath: database.resolvedPath,
    }, `Runtime listening on http://${host}:${port}`);
    if (recoveredStuckThreadCount > 0) {
      app.logService.log("info", "runtime", `Recovered ${recoveredStuckThreadCount} stuck thread(s)`);
    }
    if (recoveredPendingCreationCount > 0) {
      app.logService.log("info", "runtime", `Recovered ${recoveredPendingCreationCount} interrupted worktree creation(s)`);
    }
    if (recoveredPendingDeletionCount > 0) {
      app.logService.log("info", "runtime", `Recovered ${recoveredPendingDeletionCount} interrupted worktree deletion(s)`);
    }
    if (recoveredAutomationRunCount > 0) {
      app.logService.log("info", "runtime", `Rebound ${recoveredAutomationRunCount} in-flight automation run(s)`);
    }
  } catch (error) {
    if (error instanceof DatabaseNotReadyError) {
      console.error(error.message);
    } else {
      console.error("Failed to start runtime.", error);
    }

    try {
      await prisma.$disconnect();
    } catch {
      // Ignore disconnect errors during startup failure.
    }

    process.exit(1);
  }
}

main();
