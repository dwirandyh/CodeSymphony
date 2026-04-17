import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GetWorktreeFileContentQuerySchema,
  GitCommitInputSchema,
  OpenWorktreeFileInputSchema,
  RenameWorktreeBranchInputSchema,
  UpdateRepositoryScriptsInputSchema,
  UpdateWorktreeFileContentInputSchema,
} from "@codesymphony/shared-types";
import { z } from "zod";
import { getGitStatus, getGitDiff, getGitBranchDiffSummary, getFileAtHead, gitCommitAll, discardGitChange, syncCurrentBranch } from "../services/git.js";
import { detectMimeType, isImageMimeType } from "../services/filesystemService.js";
import { TeardownError } from "../services/worktreeService.js";

const repositoryParams = z.object({ id: z.string().min(1) });
const worktreeParams = z.object({ id: z.string().min(1) });
const GIT_STATUS_CACHE_TTL_MS = 2_000;
const REPOSITORY_REVIEW_CACHE_TTL_MS = 10_000;

type GitStatusResult = Awaited<ReturnType<typeof getGitStatus>>;
type GitBranchDiffSummaryResult = Awaited<ReturnType<typeof getGitBranchDiffSummary>>;
type RepositoryReviewStateResult = Awaited<ReturnType<FastifyInstance["reviewService"]["getRepositoryReviews"]>>;

const cachedGitStatusByWorktreeId = new Map<string, { expiresAt: number; value: GitStatusResult }>();
const inFlightGitStatusByWorktreeId = new Map<string, Promise<GitStatusResult>>();
const cachedBranchDiffByWorktreeKey = new Map<string, { expiresAt: number; value: GitBranchDiffSummaryResult }>();
const inFlightBranchDiffByWorktreeKey = new Map<string, Promise<GitBranchDiffSummaryResult>>();
const cachedReviewsByRepositoryId = new Map<string, { expiresAt: number; value: RepositoryReviewStateResult }>();
const inFlightReviewsByRepositoryId = new Map<string, Promise<RepositoryReviewStateResult>>();

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function invalidateCachedWorktreeGitData(worktreeId: string) {
  cachedGitStatusByWorktreeId.delete(worktreeId);
  inFlightGitStatusByWorktreeId.delete(worktreeId);

  for (const key of cachedBranchDiffByWorktreeKey.keys()) {
    if (key.startsWith(`${worktreeId}:`)) {
      cachedBranchDiffByWorktreeKey.delete(key);
    }
  }

  for (const key of inFlightBranchDiffByWorktreeKey.keys()) {
    if (key.startsWith(`${worktreeId}:`)) {
      inFlightBranchDiffByWorktreeKey.delete(key);
    }
  }
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

async function getCachedGitStatus(worktreeId: string, worktreePath: string): Promise<GitStatusResult> {
  const now = Date.now();
  const cached = cachedGitStatusByWorktreeId.get(worktreeId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = inFlightGitStatusByWorktreeId.get(worktreeId);
  if (inFlight) {
    return inFlight;
  }

  const requestPromise = getGitStatus(worktreePath)
    .then((status) => {
      cachedGitStatusByWorktreeId.set(worktreeId, {
        value: status,
        expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS,
      });
      return status;
    })
    .finally(() => {
      inFlightGitStatusByWorktreeId.delete(worktreeId);
    });

  inFlightGitStatusByWorktreeId.set(worktreeId, requestPromise);
  return requestPromise;
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

async function getCachedGitBranchDiffSummary(worktreeId: string, worktreePath: string, baseBranch: string): Promise<GitBranchDiffSummaryResult> {
  const cacheKey = `${worktreeId}:${baseBranch}`;
  const now = Date.now();
  const cached = cachedBranchDiffByWorktreeKey.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = inFlightBranchDiffByWorktreeKey.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const requestPromise = getGitBranchDiffSummary(worktreePath, baseBranch)
    .then((summary) => {
      cachedBranchDiffByWorktreeKey.set(cacheKey, {
        value: summary,
        expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS,
      });
      return summary;
    })
    .finally(() => {
      inFlightBranchDiffByWorktreeKey.delete(cacheKey);
    });

  inFlightBranchDiffByWorktreeKey.set(cacheKey, requestPromise);
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

    try {
      const reviews = await getCachedRepositoryReviews(app, params.id);
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

    // Force-remove all worktrees (skip teardown, log errors but don't abort)
    for (const wt of repository.worktrees) {
      try {
        await app.worktreeService.remove(wt.id, { force: true });
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
      const { worktree, scriptResult } = await app.worktreeService.create(params.id, request.body);
      app.workspaceEventHub.emit("worktree.created", {
        repositoryId: worktree.repositoryId,
        worktreeId: worktree.id,
      });
      return reply.code(201).send({ data: worktree, scriptResult });
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
      const worktree = await app.worktreeService.getById(params.id);
      if (!worktree) {
        return reply.code(404).send({ error: "Worktree not found" });
      }
      await app.worktreeService.remove(params.id, { force });
      app.workspaceEventHub.emit("worktree.deleted", {
        repositoryId: worktree.repositoryId,
        worktreeId: worktree.id,
      });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof TeardownError) {
        return reply.code(409).send({ error: "Teardown scripts failed", output: error.output });
      }
      const message = error instanceof Error ? error.message : "Unable to delete worktree";
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
      const message = error instanceof Error ? error.message : "Unable to get PR/MR thread";
      if (message === "Worktree not found") {
        return reply.code(404).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/worktrees/:id/run-setup", async (request, reply) => {
    const params = worktreeParams.parse(request.params);

    try {
      const result = await app.worktreeService.rerunSetup(params.id);
      return { data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to run setup scripts";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/worktrees/:id/run-setup/stream", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
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

  const filesQuery = z.object({ q: z.string().optional().default("") });

  app.get("/worktrees/:id/files", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const query = filesQuery.parse(request.query);

    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) {
      return reply.code(404).send({ error: "Worktree not found" });
    }

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

    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) {
      return reply.code(404).send({ error: "Worktree not found" });
    }

    try {
      const results = await app.fileService.listFileIndex(worktree.path);
      return { data: results };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list files";
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/worktrees/:id/files/content", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const query = GetWorktreeFileContentQuerySchema.parse(request.query);

    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) {
      return reply.code(404).send({ error: "Worktree not found" });
    }

    try {
      const { canonicalTargetPath, relativePath } = await resolveWorktreeFile(worktree, query.path);
      const buffer = await readFile(canonicalTargetPath);
      const mimeType = detectMimeType(canonicalTargetPath);
      if (isImageMimeType(mimeType)) {
        return {
          data: {
            path: relativePath,
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
          path: relativePath,
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

    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) {
      return reply.code(404).send({ error: "Worktree not found" });
    }

    try {
      const { canonicalTargetPath, relativePath } = await resolveWorktreeFile(worktree, input.path);
      await writeFile(canonicalTargetPath, input.content, "utf8");
      invalidateCachedWorktreeGitData(worktree.id);
      app.workspaceEventHub.emit("worktree.updated", {
        repositoryId: worktree.repositoryId,
        worktreeId: worktree.id,
      });
      return {
        data: {
          path: relativePath,
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
    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const status = await getCachedGitStatus(worktree.id, worktree.path);
      return { data: status };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to get git status";
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/worktrees/:id/git/branch-diff-summary", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const summary = await getCachedGitBranchDiffSummary(worktree.id, worktree.path, worktree.baseBranch);
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
    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const diff = await getGitDiff(worktree.path, query.filePath);
      const status = await getCachedGitStatus(worktree.id, worktree.path);
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
    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    const oldContent = await getFileAtHead(worktree.path, query.path);
    let newContent: string | null = null;
    try {
      newContent = await readFile(path.join(worktree.path, query.path), "utf8");
    } catch {
      // File deleted in working tree
    }

    return { data: { oldContent, newContent } };
  });

  app.post("/worktrees/:id/git/commit", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const { message } = GitCommitInputSchema.parse(request.body);
    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      let finalMessage = message;
      if (!finalMessage.trim()) {
        const diff = await getGitDiff(worktree.path);
        finalMessage = await app.chatService.generateCommitMessage(worktree.path, diff);
      }

      const result = await gitCommitAll(worktree.path, finalMessage);
      invalidateCachedWorktreeGitData(worktree.id);
      app.workspaceEventHub.emit("worktree.updated", {
        repositoryId: worktree.repositoryId,
        worktreeId: worktree.id,
      });
      return { data: { result } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Commit failed";
      return reply.code(400).send({ error: msg });
    }
  });

  app.post("/worktrees/:id/git/sync", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      const result = await syncCurrentBranch(worktree.path);
      invalidateCachedWorktreeGitData(worktree.id);
      app.workspaceEventHub.emit("worktree.updated", {
        repositoryId: worktree.repositoryId,
        worktreeId: worktree.id,
      });
      return { data: result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Sync failed";
      return reply.code(400).send({ error: msg });
    }
  });

  const discardParams = z.object({ id: z.string().min(1) });
  const discardBody = z.object({ filePath: z.string().min(1) });

  app.post("/worktrees/:id/git/discard", async (request, reply) => {
    const params = discardParams.parse(request.params);
    const { filePath } = discardBody.parse(request.body);
    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    try {
      await discardGitChange(worktree.path, filePath);
      invalidateCachedWorktreeGitData(worktree.id);
      app.workspaceEventHub.emit("worktree.updated", {
        repositoryId: worktree.repositoryId,
        worktreeId: worktree.id,
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

    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) {
      return reply.code(404).send({ error: "Worktree not found" });
    }

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
