import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRepositoryRoutes } from "../src/routes/repositories";

function buildWorktree(worktreePath: string) {
  return {
    id: "wt-1",
    repositoryId: "repo-1",
    branch: "feature/test",
    path: worktreePath,
    baseBranch: "main",
    status: "active" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("POST /api/worktrees/:id/files/open", () => {
  let app: FastifyInstance;
  let tempRoot: string;
  const getWorktreeById = vi.fn();
  const openFileDefaultApp = vi.fn();

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "codesymphony-open-file-"));

    app = Fastify({ logger: false });
    app.decorate("repositoryService", {
      list: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
    } as never);
    app.decorate("worktreeService", {
      create: vi.fn(),
      getById: getWorktreeById,
      remove: vi.fn(),
      listThreads: vi.fn(),
    } as never);
    app.decorate("fileService", {
      searchFiles: vi.fn(),
    } as never);
    app.decorate("systemService", {
      pickDirectory: vi.fn(),
      openFileDefaultApp,
    } as never);

    await app.register(registerRepositoryRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(tempRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns 404 when worktree is missing", async () => {
    getWorktreeById.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: "POST",
      url: "/api/worktrees/wt-unknown/files/open",
      payload: { path: "README.md" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Worktree not found" });
    expect(openFileDefaultApp).not.toHaveBeenCalled();
  });

  it("returns 400 when target path escapes worktree root", async () => {
    const worktreePath = path.join(tempRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(tempRoot, "outside.txt"), "outside");
    getWorktreeById.mockResolvedValueOnce(buildWorktree(worktreePath));

    const response = await app.inject({
      method: "POST",
      url: "/api/worktrees/wt-1/files/open",
      payload: { path: "../outside.txt" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Path must be inside the selected worktree" });
    expect(openFileDefaultApp).not.toHaveBeenCalled();
  });

  it("returns 400 when target does not exist or is not a file", async () => {
    const worktreePath = path.join(tempRoot, "worktree");
    const nestedDirectory = path.join(worktreePath, "docs");
    await mkdir(nestedDirectory, { recursive: true });
    getWorktreeById.mockResolvedValueOnce(buildWorktree(worktreePath));

    const response = await app.inject({
      method: "POST",
      url: "/api/worktrees/wt-1/files/open",
      payload: { path: "docs" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Target file does not exist" });
    expect(openFileDefaultApp).not.toHaveBeenCalled();
  });

  it("returns 204 and opens file with system service when valid", async () => {
    const worktreePath = path.join(tempRoot, "worktree");
    const filePath = path.join(worktreePath, "README.md");
    await mkdir(worktreePath, { recursive: true });
    await writeFile(filePath, "hello");
    getWorktreeById.mockResolvedValueOnce(buildWorktree(worktreePath));
    openFileDefaultApp.mockResolvedValueOnce(undefined);

    const response = await app.inject({
      method: "POST",
      url: "/api/worktrees/wt-1/files/open",
      payload: { path: "README.md" },
    });

    expect(response.statusCode).toBe(204);
    expect(openFileDefaultApp).toHaveBeenCalledTimes(1);
    expect(openFileDefaultApp).toHaveBeenCalledWith(await realpath(filePath));
  });
});
