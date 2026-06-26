import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { cp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GetWorktreeFileContentQuerySchema,
  GitCommitInputSchema,
  OpenWorktreeFileInputSchema,
  RenameWorktreeBranchInputSchema,
  UpdateRepositoryScriptsInputSchema,
  UpdateWorktreeBaseBranchInputSchema,
  UpdateWorktreeFileContentInputSchema,
} from "@codesymphony/shared-types";
import { z } from "zod";
import { getGitStatus, getGitDiff, getGitBranchDiffSummary, getFileAtHeadBuffer, gitCommitAll, discardGitChange, syncCurrentBranch, rebaseWorktreeOntoBaseBranch } from "../services/git.js";
import { detectMimeType, isImageMimeType } from "../services/filesystemService.js";
import {
  getUnavailableWorktreeErrorMessage,
  isOperationalWorktreeStatus,
  isUnavailableWorktreeErrorMessage,
} from "../services/worktreeService.js";
import {
  getCachedWorktreeGitBranchDiffSummary,
  getCachedWorktreeGitStatus,
  invalidateCachedWorktreeGitData,
} from "../services/worktreeGitQueryCache.js";
import { publishWorktreeActivity, WORKTREE_ACTIVITY } from "../services/worktreeActivity.js";
import { appendRuntimeDebugLog } from "./debug.js";

const repositoryParams = z.object({ id: z.string().min(1) });
const worktreeParams = z.object({ id: z.string().min(1) });
const gitStatusQuery = z.object({
  refresh: z.string().optional().transform((value) => value === "true" || value === "1"),
});
const filesQuery = z.object({ q: z.string().optional().default("") });
const fileTreeQuery = z.object({ path: z.string().optional() });
const worktreePathBody = z.object({
  path: z.string().trim().min(1),
});
const worktreeCreateFileBody = z.object({
  path: z.string().trim().min(1),
  content: z.string().optional().default(""),
});
const worktreeCreateDirectoryBody = z.object({
  path: z.string().trim().min(1),
});
const worktreeRenamePathBody = z.object({
  path: z.string().trim().min(1),
  name: z.string().trim().min(1),
});
const worktreePathTransferBody = z.object({
  sourcePath: z.string().trim().min(1),
  destinationDirectoryPath: z.string().trim().optional().default(""),
  overwrite: z.boolean().optional().default(false),
});
const worktreePasteFromHostClipboardBody = z.object({
  destinationDirectoryPath: z.string().trim().optional().default(""),
});
// These sidebar metadata requests are non-critical and expensive enough that
// recomputing them on every page refresh can stall other thread bootstrap
// requests behind the browser's per-origin connection limits.
const REPOSITORY_REVIEW_CACHE_TTL_MS = 60_000;

type RepositoryReviewStateResult = Awaited<ReturnType<FastifyInstance["reviewService"]["getRepositoryReviews"]>>;

const cachedReviewsByRepositoryId = new Map<string, { expiresAt: number; value: RepositoryReviewStateResult }>();
const inFlightReviewsByRepositoryId = new Map<string, Promise<RepositoryReviewStateResult>>();

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.includes(0);
}

async function resolveWorktreeFile(worktree: { path: string }, inputPath: string) {
  const rootPath = path.resolve(worktree.path);
  const targetPath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootPath, inputPath);

  if (!isPathInsideRoot(rootPath, targetPath)) {
    throw new Error("Path must be inside the selected worktree");
  }

  const targetStat = await stat(targetPath).catch(() => null);
  if (!targetStat || !targetStat.isFile()) {
    throw new Error("Target file does not exist");
  }

  const canonicalRootPath = await realpath(rootPath).catch(() => rootPath);
  const canonicalTargetPath = await realpath(targetPath).catch(() => targetPath);
  if (!isPathInsideRoot(canonicalRootPath, canonicalTargetPath)) {
    throw new Error("Path must be inside the selected worktree");
  }

  return {
    canonicalTargetPath,
    relativePath: path.relative(canonicalRootPath, canonicalTargetPath).split(path.sep).join("/"),
  };
}

async function resolveEditorFile(worktree: { path: string }, inputPath: string) {
  const rootPath = path.resolve(worktree.path);
  const targetPath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootPath, inputPath);

  if (!path.isAbsolute(inputPath) && !isPathInsideRoot(rootPath, targetPath)) {
    throw new Error("Path must be inside the selected worktree");
  }

  const targetStat = await stat(targetPath).catch(() => null);
  if (!targetStat || !targetStat.isFile()) {
    throw new Error("Target file does not exist");
  }

  const canonicalRootPath = await realpath(rootPath).catch(() => rootPath);
  const canonicalTargetPath = await realpath(targetPath).catch(() => targetPath);
  if (isPathInsideRoot(canonicalRootPath, canonicalTargetPath)) {
    return {
      canonicalTargetPath,
      editorPath: path.relative(canonicalRootPath, canonicalTargetPath).split(path.sep).join("/"),
      external: false,
    };
  }

  if (!path.isAbsolute(inputPath)) {
    throw new Error("Path must be inside the selected worktree");
  }

  return {
    canonicalTargetPath,
    editorPath: canonicalTargetPath,
    external: true,
  };
}

async function resolveWorktreeDirectory(worktree: { path: string }, inputPath?: string) {
  const rootPath = path.resolve(worktree.path);
  const targetPath = inputPath && inputPath.trim().length > 0
    ? (path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(rootPath, inputPath))
    : rootPath;

  if (!isPathInsideRoot(rootPath, targetPath)) {
    throw new Error("Path must be inside the selected worktree");
  }

  const targetStat = await stat(targetPath).catch(() => null);
  if (!targetStat || !targetStat.isDirectory()) {
    throw new Error("Target directory does not exist");
  }

  const canonicalRootPath = await realpath(rootPath).catch(() => rootPath);
  const canonicalTargetPath = await realpath(targetPath).catch(() => targetPath);
  if (!isPathInsideRoot(canonicalRootPath, canonicalTargetPath)) {
    throw new Error("Path must be inside the selected worktree");
  }

  const relativePath = path.relative(rootPath, targetPath).split(path.sep).join("/");

  return {
    relativePath: relativePath === "." ? "" : relativePath,
  };
}

async function resolveWorktreePathForWrite(worktree: { path: string }, inputPath: string) {
  const rootPath = path.resolve(worktree.path);
  const targetPath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootPath, inputPath);

  if (!isPathInsideRoot(rootPath, targetPath)) {
    throw new Error("Path must be inside the selected worktree");
  }

  const canonicalRootPath = await realpath(rootPath).catch(() => rootPath);
  const existingAncestorPath = await findExistingAncestor(targetPath, canonicalRootPath);
  const canonicalAncestorPath = await realpath(existingAncestorPath).catch(() => existingAncestorPath);
  if (!isPathInsideRoot(canonicalRootPath, canonicalAncestorPath)) {
    throw new Error("Path must be inside the selected worktree");
  }

  return {
    rootPath,
    targetPath,
    relativePath: path.relative(rootPath, targetPath).split(path.sep).join("/"),
  };
}

async function findExistingAncestor(targetPath: string, rootPath: string) {
  let currentPath = targetPath;
  while (currentPath.length >= rootPath.length) {
    const currentStat = await stat(currentPath).catch(() => null);
    if (currentStat) {
      return currentPath;
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }
  return rootPath;
}

function assertSafeBasename(name: string) {
  if (name !== path.basename(name) || name === "." || name === "..") {
    throw new Error("Name must not include path separators");
  }
}

function publishWorktreeFilesChanged(app: FastifyInstance, worktree: { id: string; repositoryId: string; path: string }) {
  app.fileService.invalidateCache(worktree.path);
  publishWorktreeActivity({
    workspaceEventHub: app.workspaceEventHub,
    worktree,
    activity: WORKTREE_ACTIVITY.WATCHER_FILES_CHANGED,
  });
}

async function getCachedRepositoryReviews(app: FastifyInstance, repositoryId: string): Promise<RepositoryReviewStateResult> {
  const now = Date.now();
  const cached = cachedReviewsByRepositoryId.get(repositoryId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = inFlightReviewsByRepositoryId.get(repositoryId);
  if (inFlight) {
    return inFlight;
  }

  const requestPromise = app.reviewService.getRepositoryReviews(repositoryId)
    .then((reviews) => {
      cachedReviewsByRepositoryId.set(repositoryId, {
        value: reviews,
        expiresAt: Date.now() + REPOSITORY_REVIEW_CACHE_TTL_MS,
      });
      return reviews;
    })
    .finally(() => {
      inFlightReviewsByRepositoryId.delete(repositoryId);
    });

  inFlightReviewsByRepositoryId.set(repositoryId, requestPromise);
  return requestPromise;
}

function writeSseHeaders(request: FastifyRequest, reply: FastifyReply) {
  const requestOrigin = Array.isArray(request.headers.origin)
    ? request.headers.origin[0]
    : request.headers.origin;
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  };

  if (requestOrigin) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
    headers.Vary = "Origin";
  }

  reply.raw.writeHead(200, headers);
}

async function getOperationalWorktree(
  app: FastifyInstance,
  worktreeId: string,
): Promise<Awaited<ReturnType<FastifyInstance["worktreeService"]["getById"]>>> {
  const worktree = await app.worktreeService.getById(worktreeId);
  if (!worktree) {
    return null;
  }

  if (!isOperationalWorktreeStatus(worktree.status)) {
    throw new Error(getUnavailableWorktreeErrorMessage(worktree));
  }

  return worktree;
}

function respondForWorktreeRouteError(
  reply: FastifyReply,
  error: unknown,
  fallbackMessage: string,
) {
  const message = error instanceof Error ? error.message : fallbackMessage;
  if (message === "Worktree not found") {
    return reply.code(404).send({ error: message });
  }
  if (isUnavailableWorktreeErrorMessage(message)) {
    return reply.code(409).send({ error: message });
  }
  return reply.code(400).send({ error: message });
}

export async function registerRepositoryRoutes(app: FastifyInstance) {
  app.get("/repositories", async () => {
    const repositories = await app.repositoryService.list();
    return { data: repositories };
  });

  app.get("/repositories/:id", async (request, reply) => {
    const params = repositoryParams.parse(request.params);
    const repository = await app.repositoryService.getById(params.id);

    if (!repository) {
      return reply.code(404).send({ error: "Repository not found" });
    }

    return { data: repository };
  });

  app.post("/repositories", async (request, reply) => {
    try {
      const repository = await app.repositoryService.create(request.body);
      app.workspaceEventHub.emit("repository.created", { repositoryId: repository.id });
      return reply.code(201).send({ data: repository });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create repository";
      return reply.code(400).send({ error: message });
    }
  });

  app.patch("/repositories/:id/scripts", async (request, reply) => {
    const params = repositoryParams.parse(request.params);

    try {
      const repository = await app.repositoryService.updateScripts(params.id, request.body);
      app.workspaceEventHub.emit("repository.updated", { repositoryId: repository.id });
      return { data: repository };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update scripts";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/repositories/:id/branches", async (request, reply) => {
    const params = repositoryParams.parse(request.params);

    try {
      const branches = await app.repositoryService.listBranches(params.id);
      return { data: branches };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list branches";
      if (message === "Repository not found") {
        return reply.code(404).send({ error: message });
      }
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/repositories/:id/reviews", async (request, reply) => {
    const params = repositoryParams.parse(request.params);
    const startedAt = Date.now();

    try {
      const reviews = await getCachedRepositoryReviews(app, params.id);
      const durationMs = Date.now() - startedAt;
      if (durationMs >= 500) {
        appendRuntimeDebugLog({
          source: "runtime.repositories",
          message: "repository.reviews.slow",
          data: {
            repositoryId: params.id,
            durationMs,
            provider: reviews.provider,
            available: reviews.available,
            reviewBranchCount: Object.keys(reviews.reviewsByBranch).length,
          },
        });
      }
      return { data: reviews };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list reviews";
      if (message === "Repository not found") {
        return reply.code(404).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });


  app.delete("/repositories/:id", async (request, reply) => {
    const params = repositoryParams.parse(request.params);
    const repository = await app.repositoryService.getById(params.id);

    if (!repository) {
      return reply.code(404).send({ error: "Repository not found" });
    }

    // Force-remove non-primary worktrees (skip teardown, log errors but don't abort).
    for (const wt of repository.worktrees) {
      try {
        if (wt.path === repository.rootPath) {
          continue;
        }
        await app.worktreeDeletionService.deleteWorktreeNow(wt.id, { force: true });
      } catch (error) {
        app.log.warn({ worktreeId: wt.id, error }, "Failed to remove worktree during repository deletion");
      }
    }

    await app.repositoryService.remove(params.id);
    app.workspaceEventHub.emit("repository.deleted", { repositoryId: params.id });
    return reply.code(204).send();
  });

  app.post("/repositories/:id/worktrees", async (request, reply) => {
    const params = repositoryParams.parse(request.params);

    try {
      const result = await app.worktreeService.create(params.id, request.body);
      app.workspaceEventHub.emit("worktree.created", {
        repositoryId: result.worktree.repositoryId,
        worktreeId: result.worktree.id,
      });
      return reply.code(201).send({ data: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create worktree";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/worktrees/:id", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const worktree = await app.worktreeService.getById(params.id);

    if (!worktree) {
      return reply.code(404).send({ error: "Worktree not found" });
    }

    return { data: worktree };
  });

  app.delete("/worktrees/:id", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const query = z.object({ force: z.string().optional() }).parse(request.query);
    const force = query.force === "true";

    try {
      await app.worktreeDeletionService.requestDeletion(params.id, { force });
      return reply.code(202).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete worktree";
      if (message === "Worktree not found") {
        return reply.code(404).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });

  app.patch("/worktrees/:id/branch", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const input = RenameWorktreeBranchInputSchema.parse(request.body);

    try {
      const worktree = await app.worktreeService.renameBranch(params.id, input.branch, { isManualRename: true });
      app.workspaceEventHub.emit("worktree.updated", {
        repositoryId: worktree.repositoryId,
        worktreeId: worktree.id,
      });
      return { data: worktree };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to rename branch";
      return reply.code(400).send({ error: message });
    }
  });

  app.patch("/worktrees/:id/base-branch", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const input = UpdateWorktreeBaseBranchInputSchema.parse(request.body);

    try {
      const worktree = await app.worktreeService.updateBaseBranch(params.id, input.baseBranch);
      app.workspaceEventHub.emit("worktree.updated", {
        repositoryId: worktree.repositoryId,
        worktreeId: worktree.id,
      });
      invalidateCachedWorktreeGitData(worktree.id);
      return { data: worktree };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update target branch";
      return reply.code(400).send({ error: message });
    }
  });


  app.post("/worktrees/:id/pr-mr-thread", async (request, reply) => {
    const params = worktreeParams.parse(request.params);

    try {
      const thread = await app.chatService.getOrCreatePrMrThread(params.id, request.body);
      const worktree = await app.worktreeService.getById(thread.worktreeId);
      app.workspaceEventHub.emit("thread.created", {
        repositoryId: worktree?.repositoryId ?? null,
        worktreeId: thread.worktreeId,
        threadId: thread.id,
      });
      return reply.code(201).send({ data: thread });
    } catch (error) {
      return respondForWorktreeRouteError(reply, error, "Unable to get PR/MR thread");
    }
  });

  app.post("/worktrees/:id/run-setup", async (request, reply) => {
    const params = worktreeParams.parse(request.params);

    try {
      await getOperationalWorktree(app, params.id);
      const result = await app.worktreeService.rerunSetup(params.id);
      return { data: result };
    } catch (error) {
      return respondForWorktreeRouteError(reply, error, "Unable to run setup scripts");
    }
  });

  app.get("/worktrees/:id/run-setup/stream", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    try {
      await getOperationalWorktree(app, params.id);
    } catch (error) {
      return respondForWorktreeRouteError(reply, error, "Unable to stream setup scripts");
    }
    const context = await app.worktreeService.getSetupContext(params.id);

    if (!context) {
      return reply.code(400).send({ error: "No setup scripts configured" });
    }

    writeSseHeaders(request, reply);

    const emitter = app.scriptStreamService.startSetupStream(
      params.id,
      context.commands,
      context.cwd,
      context.env,
    );

    function onData(chunk: string) {
      reply.raw.write(`event: output\ndata: ${JSON.stringify({ chunk })}\n\n`);
    }

    function onEnd({ success }: { success: boolean }) {
      reply.raw.write(`event: done\ndata: ${JSON.stringify({ success })}\n\n`);
      cleanup();
      reply.raw.end();
    }

    function cleanup() {
      emitter.removeListener("data", onData);
      emitter.removeListener("end", onEnd);
    }

    emitter.on("data", onData);
    emitter.on("end", onEnd);

    request.raw.on("close", () => {
      cleanup();
      app.scriptStreamService.stopScript(params.id);
    });
  });

  app.post("/worktrees/:id/run-setup/stop", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    app.scriptStreamService.stopScript(params.id);
    return reply.code(204).send();
  });

  app.get("/worktrees/:id/files", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const query = filesQuery.parse(request.query);

    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to search files";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const results = await app.fileService.searchFiles(worktree.path, query.q, 20);
      return { data: results };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to search files";
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/worktrees/:id/files/index", async (request, reply) => {
    const params = worktreeParams.parse(request.params);

    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list files";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const results = await app.fileService.listFileIndex(worktree.path);
      return { data: results };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list files";
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/worktrees/:id/files/tree", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const query = fileTreeQuery.parse(request.query);

    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list directory";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const { relativePath } = await resolveWorktreeDirectory(worktree, query.path);
      const results = await app.fileService.listDirectory(worktree.path, relativePath);
      return { data: results };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list directory";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/worktrees/:id/files/create-file", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const input = worktreeCreateFileBody.parse(request.body);

    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create file";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const { targetPath, relativePath } = await resolveWorktreePathForWrite(worktree, input.path);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, input.content, { encoding: "utf8", flag: "wx" });
      publishWorktreeFilesChanged(app, worktree);
      return reply.code(201).send({ data: { path: relativePath, type: "file" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create file";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/worktrees/:id/files/create-directory", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const input = worktreeCreateDirectoryBody.parse(request.body);

    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create folder";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const { targetPath, relativePath } = await resolveWorktreePathForWrite(worktree, input.path);
      const existing = await stat(targetPath).catch(() => null);
      if (existing) {
        throw new Error("Target already exists");
      }
      await mkdir(targetPath, { recursive: true });
      publishWorktreeFilesChanged(app, worktree);
      return reply.code(201).send({ data: { path: relativePath, type: "directory" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create folder";
      return reply.code(400).send({ error: message });
    }
  });

  app.patch("/worktrees/:id/files/rename", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const input = worktreeRenamePathBody.parse(request.body);

    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to rename path";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      assertSafeBasename(input.name);
      const source = await resolveWorktreePathForWrite(worktree, input.path);
      const sourceStat = await stat(source.targetPath).catch(() => null);
      if (!sourceStat) {
        throw new Error("Source path does not exist");
      }
      const destinationPath = path.join(path.dirname(source.targetPath), input.name);
      const destination = await resolveWorktreePathForWrite(worktree, destinationPath);
      const destinationStat = await stat(destination.targetPath).catch(() => null);
      if (destinationStat) {
        throw new Error("Target already exists");
      }
      await rename(source.targetPath, destination.targetPath);
      publishWorktreeFilesChanged(app, worktree);
      return { data: { path: destination.relativePath, type: sourceStat.isDirectory() ? "directory" : "file" } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to rename path";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/worktrees/:id/files/copy", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const input = worktreePathTransferBody.parse(request.body);

    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to copy path";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const source = await resolveWorktreePathForWrite(worktree, input.sourcePath);
      const sourceStat = await stat(source.targetPath).catch(() => null);
      if (!sourceStat) {
        throw new Error("Source path does not exist");
      }
      const destinationDirectory = await resolveWorktreePathForWrite(worktree, input.destinationDirectoryPath);
      const destinationDirectoryStat = await stat(destinationDirectory.targetPath).catch(() => null);
      if (!destinationDirectoryStat?.isDirectory()) {
        throw new Error("Destination directory does not exist");
      }
      const destination = await resolveWorktreePathForWrite(
        worktree,
        path.join(destinationDirectory.targetPath, path.basename(source.targetPath)),
      );
      await cp(source.targetPath, destination.targetPath, {
        recursive: sourceStat.isDirectory(),
        force: input.overwrite,
        errorOnExist: !input.overwrite,
      });
      publishWorktreeFilesChanged(app, worktree);
      return { data: { path: destination.relativePath, type: sourceStat.isDirectory() ? "directory" : "file" } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to copy path";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/worktrees/:id/files/move", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const input = worktreePathTransferBody.parse(request.body);

    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to move path";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const source = await resolveWorktreePathForWrite(worktree, input.sourcePath);
      const sourceStat = await stat(source.targetPath).catch(() => null);
      if (!sourceStat) {
        throw new Error("Source path does not exist");
      }
      const destinationDirectory = await resolveWorktreePathForWrite(worktree, input.destinationDirectoryPath);
      const destinationDirectoryStat = await stat(destinationDirectory.targetPath).catch(() => null);
      if (!destinationDirectoryStat?.isDirectory()) {
        throw new Error("Destination directory does not exist");
      }
      const destination = await resolveWorktreePathForWrite(
        worktree,
        path.join(destinationDirectory.targetPath, path.basename(source.targetPath)),
      );
      const destinationStat = await stat(destination.targetPath).catch(() => null);
      if (destinationStat) {
        throw new Error("Target already exists");
      }
      await rename(source.targetPath, destination.targetPath);
      publishWorktreeFilesChanged(app, worktree);
      return { data: { path: destination.relativePath, type: sourceStat.isDirectory() ? "directory" : "file" } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to move path";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/worktrees/:id/files/paste-from-host-clipboard", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const input = worktreePasteFromHostClipboardBody.parse(request.body ?? {});

    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to paste clipboard paths";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const sourcePaths = await app.systemService.readClipboardFilePaths();
      if (sourcePaths.length === 0) {
        throw new Error("Host clipboard does not contain copied files or folders");
      }

      const destinationDirectory = await resolveWorktreePathForWrite(worktree, input.destinationDirectoryPath);
      const destinationDirectoryStat = await stat(destinationDirectory.targetPath).catch(() => null);
      if (!destinationDirectoryStat?.isDirectory()) {
        throw new Error("Destination directory does not exist");
      }

      const entries = [];
      for (const sourcePath of sourcePaths) {
        const sourceStat = await stat(sourcePath).catch(() => null);
        if (!sourceStat) {
          throw new Error(`Clipboard path does not exist: ${sourcePath}`);
        }

        const sourceName = path.basename(sourcePath);
        assertSafeBasename(sourceName);
        const destination = await resolveWorktreePathForWrite(
          worktree,
          path.join(destinationDirectory.targetPath, sourceName),
        );
        await cp(sourcePath, destination.targetPath, {
          recursive: sourceStat.isDirectory(),
          force: false,
          errorOnExist: true,
        });
        entries.push({
          path: destination.relativePath,
          type: sourceStat.isDirectory() ? "directory" as const : "file" as const,
        });
      }

      publishWorktreeFilesChanged(app, worktree);
      return { data: entries };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to paste clipboard paths";
      return reply.code(400).send({ error: message });
    }
  });

  app.delete("/worktrees/:id/files/path", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const input = worktreePathBody.parse(request.body);

    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete path";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const target = await resolveWorktreePathForWrite(worktree, input.path);
      const targetStat = await stat(target.targetPath).catch(() => null);
      if (!targetStat) {
        throw new Error("Target path does not exist");
      }
      await rm(target.targetPath, { recursive: targetStat.isDirectory(), force: false });
      publishWorktreeFilesChanged(app, worktree);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete path";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/worktrees/:id/files/content", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const query = GetWorktreeFileContentQuerySchema.parse(request.query);

    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read file";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const { canonicalTargetPath, editorPath } = await resolveEditorFile(worktree, query.path);
      const buffer = await readFile(canonicalTargetPath);
      const mimeType = detectMimeType(canonicalTargetPath);
      if (isImageMimeType(mimeType)) {
        return {
          data: {
            path: editorPath,
            content: buffer.toString("base64"),
            mimeType,
          },
        };
      }

      if (isBinaryBuffer(buffer)) {
        return reply.code(400).send({ error: "Binary files cannot be opened in the editor" });
      }

      return {
        data: {
          path: editorPath,
          content: buffer.toString("utf8"),
          mimeType,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read file";
      return reply.code(400).send({ error: message });
    }
  });

  app.put("/worktrees/:id/files/content", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const input = UpdateWorktreeFileContentInputSchema.parse(request.body);

    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save file";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const { canonicalTargetPath, editorPath, external } = await resolveEditorFile(worktree, input.path);
      await writeFile(canonicalTargetPath, input.content, "utf8");
      if (!external) {
        publishWorktreeActivity({
          workspaceEventHub: app.workspaceEventHub,
          worktree,
          activity: WORKTREE_ACTIVITY.FILE_SAVED,
        });
      }
      return {
        data: {
          path: editorPath,
          content: input.content,
          mimeType: detectMimeType(canonicalTargetPath),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save file";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/worktrees/:id/git/status", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const query = gitStatusQuery.parse(request.query);
    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to get git status";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const status = await getCachedWorktreeGitStatus(worktree.id, worktree.path, {
        refresh: query.refresh === true,
      });
      return { data: status };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to get git status";
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/worktrees/:id/git/branch-diff-summary", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const startedAt = Date.now();
    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to get branch diff summary";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const summary = await getCachedWorktreeGitBranchDiffSummary(
        worktree.id,
        worktree.path,
        worktree.baseBranch,
        worktree.branch,
      );
      const durationMs = Date.now() - startedAt;
      if (durationMs >= 500) {
        appendRuntimeDebugLog({
          source: "runtime.repositories",
          message: "worktree.branchDiffSummary.slow",
          data: {
            worktreeId: worktree.id,
            baseBranch: worktree.baseBranch,
            durationMs,
            available: summary.available,
            filesChanged: summary.available ? summary.filesChanged : null,
          },
        });
      }
      return { data: summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to get branch diff summary";
      return reply.code(500).send({ error: message });
    }
  });

  const diffQuery = z.object({ filePath: z.string().optional() });

  app.get("/worktrees/:id/git/diff", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const query = diffQuery.parse(request.query);
    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to get git diff";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const diff = await getGitDiff(worktree.path, query.filePath);
      const status = await getCachedWorktreeGitStatus(worktree.id, worktree.path);
      const summary = status.entries.map((e) => `${e.status}: ${e.path}`).join("\n");
      return { data: { diff, summary } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to get git diff";
      return reply.code(500).send({ error: message });
    }
  });

  const fileContentsQuery = z.object({ path: z.string().min(1) });

  app.get("/worktrees/:id/git/file-contents", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const query = fileContentsQuery.parse(request.query);
    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to get file contents";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    const mimeType = detectMimeType(query.path);
    const isImage = isImageMimeType(mimeType);
    const oldBuffer = await getFileAtHeadBuffer(worktree.path, query.path);
    const oldSize = oldBuffer?.byteLength ?? null;
    const oldContent = oldBuffer && !isBinaryBuffer(oldBuffer) ? oldBuffer.toString("utf8") : null;
    let newBuffer: Buffer | null = null;
    let newContent: string | null = null;
    try {
      newBuffer = await readFile(path.join(worktree.path, query.path));
      newContent = !isBinaryBuffer(newBuffer) ? newBuffer.toString("utf8") : null;
    } catch {
      // File deleted in working tree
    }

    return {
      data: {
        oldContent,
        newContent,
        oldBase64: isImage && oldBuffer ? oldBuffer.toString("base64") : null,
        newBase64: isImage && newBuffer ? newBuffer.toString("base64") : null,
        oldSize,
        newSize: newBuffer?.byteLength ?? null,
        oldBinary: oldBuffer ? isBinaryBuffer(oldBuffer) : false,
        newBinary: newBuffer ? isBinaryBuffer(newBuffer) : false,
        mimeType,
      },
    };
  });

  app.post("/worktrees/:id/git/commit", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const { message, agent, model, modelProviderId } = GitCommitInputSchema.parse(request.body);
    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Commit failed";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      let finalMessage = message;
      if (!finalMessage.trim()) {
        const diff = await getGitDiff(worktree.path);
        finalMessage = await app.chatService.generateCommitMessage(worktree.path, diff, {
          agent,
          model,
          modelProviderId,
        });
      }

      const result = await gitCommitAll(worktree.path, finalMessage);
      publishWorktreeActivity({
        workspaceEventHub: app.workspaceEventHub,
        worktree,
        activity: WORKTREE_ACTIVITY.GIT_COMMITTED,
      });
      return { data: { result } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Commit failed";
      return reply.code(400).send({ error: msg });
    }
  });

  app.post("/worktrees/:id/git/sync", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const result = await syncCurrentBranch(worktree.path);
      publishWorktreeActivity({
        workspaceEventHub: app.workspaceEventHub,
        worktree,
        activity: WORKTREE_ACTIVITY.GIT_SYNCED,
      });
      return { data: result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Sync failed";
      return reply.code(400).send({ error: msg });
    }
  });

  app.post("/worktrees/:id/git/rebase-base", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Rebase failed";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });
    if (!worktree.baseBranch) {
      return reply.code(400).send({ error: "Worktree has no base branch configured" });
    }

    try {
      const result = await rebaseWorktreeOntoBaseBranch(worktree.path, worktree.baseBranch);
      publishWorktreeActivity({
        workspaceEventHub: app.workspaceEventHub,
        worktree,
        activity: WORKTREE_ACTIVITY.GIT_SYNCED,
      });
      return { data: result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Rebase failed";
      return reply.code(400).send({ error: msg });
    }
  });

  const discardParams = z.object({ id: z.string().min(1) });
  const discardBody = z.object({ filePath: z.string().min(1) });

  app.post("/worktrees/:id/git/discard", async (request, reply) => {
    const params = discardParams.parse(request.params);
    const { filePath } = discardBody.parse(request.body);
    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Discard failed";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      await discardGitChange(worktree.path, filePath);
      publishWorktreeActivity({
        workspaceEventHub: app.workspaceEventHub,
        worktree,
        activity: WORKTREE_ACTIVITY.GIT_DISCARDED,
      });
      return reply.code(204).send();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Discard failed";
      return reply.code(400).send({ error: msg });
    }
  });

  app.post("/worktrees/:id/files/open", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const input = OpenWorktreeFileInputSchema.parse(request.body);

    let worktree;
    try {
      worktree = await getOperationalWorktree(app, params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to open file";
      return reply.code(409).send({ error: message });
    }
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const { canonicalTargetPath } = await resolveWorktreeFile(worktree, input.path);
      await app.systemService.openFileDefaultApp(canonicalTargetPath);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to open file";
      return reply.code(400).send({ error: message });
    }
  });
}
