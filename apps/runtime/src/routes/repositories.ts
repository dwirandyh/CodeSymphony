import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { GitCommitInputSchema, OpenWorktreeFileInputSchema, RenameWorktreeBranchInputSchema, UpdateRepositoryScriptsInputSchema } from "@codesymphony/shared-types";
import { z } from "zod";
import { getGitStatus, getGitDiff, getFileAtHead, gitCommitAll, discardGitChange } from "../services/git";
import { TeardownError } from "../services/worktreeService";

const repositoryParams = z.object({ id: z.string().min(1) });
const worktreeParams = z.object({ id: z.string().min(1) });

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
      return { data: repository };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update scripts";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/repositories/:id/worktrees", async (request, reply) => {
    const params = repositoryParams.parse(request.params);

    try {
      const { worktree, scriptResult } = await app.worktreeService.create(params.id, request.body);
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
      await app.worktreeService.remove(params.id, { force });
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
      return { data: worktree };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to rename branch";
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

  const runScriptQuery = z.object({ cmd: z.string().min(1).optional() });

  app.get("/worktrees/:id/run-script/stream", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const { cmd } = runScriptQuery.parse(request.query);

    let commands: string[];
    let cwd: string;
    let env: Record<string, string>;

    if (cmd) {
      const worktree = await app.worktreeService.getById(params.id);
      if (!worktree) {
        return reply.code(404).send({ error: "Worktree not found" });
      }
      commands = [cmd];
      cwd = worktree.path;
      env = {};
    } else {
      const context = await app.worktreeService.getRunScriptContext(params.id);
      if (!context) {
        return reply.code(400).send({ error: "No run script configured" });
      }
      commands = context.commands;
      cwd = context.cwd;
      env = context.env;
    }

    writeSseHeaders(request, reply);

    const scriptKey = `run:${params.id}`;
    const emitter = app.scriptStreamService.startSetupStream(
      scriptKey,
      commands,
      cwd,
      env,
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
      app.scriptStreamService.stopScript(scriptKey);
    });
  });

  app.post("/worktrees/:id/run-script/stop", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    app.scriptStreamService.stopScript(`run:${params.id}`);
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

  app.get("/worktrees/:id/git/status", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    const status = await getGitStatus(worktree.path);
    return { data: status };
  });

  const diffQuery = z.object({ filePath: z.string().optional() });

  app.get("/worktrees/:id/git/diff", async (request, reply) => {
    const params = worktreeParams.parse(request.params);
    const query = diffQuery.parse(request.query);
    const worktree = await app.worktreeService.getById(params.id);
    if (!worktree) return reply.code(404).send({ error: "Worktree not found" });

    const diff = await getGitDiff(worktree.path, query.filePath);
    const status = await getGitStatus(worktree.path);
    const summary = status.entries.map((e) => `${e.status}: ${e.path}`).join("\n");
    return { data: { diff, summary } };
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
      return { data: { result } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Commit failed";
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
