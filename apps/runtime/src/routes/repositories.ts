import type { FastifyInstance } from "fastify";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { OpenWorktreeFileInputSchema } from "@codesymphony/shared-types";
import { z } from "zod";

const repositoryParams = z.object({ id: z.string().min(1) });
const worktreeParams = z.object({ id: z.string().min(1) });

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
      return reply.code(201).send({ data: repository });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create repository";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/repositories/:id/worktrees", async (request, reply) => {
    const params = repositoryParams.parse(request.params);

    try {
      const worktree = await app.worktreeService.create(params.id, request.body);
      return reply.code(201).send({ data: worktree });
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

    try {
      await app.worktreeService.remove(params.id);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete worktree";
      return reply.code(400).send({ error: message });
    }
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

  app.post("/worktrees/:id/files/open", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const input = OpenWorktreeFileInputSchema.parse(request.body);

    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) {
      return reply.code(404).send({ error: "Worktree not found" });
    }

    const rootPath = path.resolve(worktree.path);
    const targetPath = path.isAbsolute(input.path)
      ? path.resolve(input.path)
      : path.resolve(rootPath, input.path);
    if (!isPathInsideRoot(rootPath, targetPath)) {
      return reply.code(400).send({ error: "Path must be inside the selected worktree" });
    }

    const targetStat = await stat(targetPath).catch(() => null);
    if (!targetStat || !targetStat.isFile()) {
      return reply.code(400).send({ error: "Target file does not exist" });
    }
    const canonicalRootPath = await realpath(rootPath).catch(() => rootPath);
    const canonicalTargetPath = await realpath(targetPath).catch(() => targetPath);
    if (!isPathInsideRoot(canonicalRootPath, canonicalTargetPath)) {
      return reply.code(400).send({ error: "Path must be inside the selected worktree" });
    }

    try {
      await app.systemService.openFileDefaultApp(canonicalTargetPath);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to open file";
      return reply.code(400).send({ error: message });
    }
  });
}
