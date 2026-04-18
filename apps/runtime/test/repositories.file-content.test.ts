import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

describe("worktree file content routes", () => {
  let app: FastifyInstance;
  let tempRoot: string;
  const getWorktreeById = vi.fn();
  const workspaceEventHubEmit = vi.fn();

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "codesymphony-file-content-"));

    app = Fastify({ logger: false });
    app.decorate("repositoryService", {
      list: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      updateScripts: vi.fn(),
      listBranches: vi.fn(),
      remove: vi.fn(),
    } as never);
    app.decorate("worktreeService", {
      create: vi.fn(),
      getById: getWorktreeById,
      remove: vi.fn(),
      listThreads: vi.fn(),
      renameBranch: vi.fn(),
    } as never);
    app.decorate("fileService", {
      searchFiles: vi.fn(),
      listFileIndex: vi.fn(),
    } as never);
    app.decorate("systemService", {
      pickDirectory: vi.fn(),
      openFileDefaultApp: vi.fn(),
    } as never);
    app.decorate("chatService", {
      generateCommitMessage: vi.fn(),
      getOrCreatePrMrThread: vi.fn(),
    } as never);
    app.decorate("scriptStreamService", {
      startSetupStream: vi.fn(),
      stopScript: vi.fn(),
    } as never);
    app.decorate("reviewService", {
      getRepositoryReviews: vi.fn(),
    } as never);
    app.decorate("workspaceEventHub", {
      emit: workspaceEventHubEmit,
    } as never);

    await app.register(registerRepositoryRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(tempRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("reads a text file inside the worktree", async () => {
    const worktreePath = path.join(tempRoot, "worktree");
    const filePath = path.join(worktreePath, "src", "index.ts");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "export const ready = true;\n");
    getWorktreeById.mockResolvedValueOnce(buildWorktree(worktreePath));

    const response = await app.inject({
      method: "GET",
      url: "/api/worktrees/wt-1/files/content?path=src/index.ts",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      path: "src/index.ts",
      content: "export const ready = true;\n",
      mimeType: "text/typescript",
    });
  });

  it("returns image files as base64 payloads", async () => {
    const worktreePath = path.join(tempRoot, "worktree");
    const filePath = path.join(worktreePath, "assets", "icon.png");
    await mkdir(path.dirname(filePath), { recursive: true });
    const imageBytes = Buffer.from([137, 80, 78, 71]);
    await writeFile(filePath, imageBytes);
    getWorktreeById.mockResolvedValueOnce(buildWorktree(worktreePath));

    const response = await app.inject({
      method: "GET",
      url: "/api/worktrees/wt-1/files/content?path=assets/icon.png",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      path: "assets/icon.png",
      content: imageBytes.toString("base64"),
      mimeType: "image/png",
    });
  });

  it("saves file content and emits a worktree update", async () => {
    const worktreePath = path.join(tempRoot, "worktree");
    const filePath = path.join(worktreePath, "src", "index.ts");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "export const ready = false;\n");
    getWorktreeById.mockResolvedValueOnce(buildWorktree(worktreePath));

    const response = await app.inject({
      method: "PUT",
      url: "/api/worktrees/wt-1/files/content",
      payload: {
        path: "src/index.ts",
        content: "export const ready = true;\n",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(await readFile(filePath, "utf8")).toBe("export const ready = true;\n");
    expect(workspaceEventHubEmit).toHaveBeenCalledWith("worktree.updated", {
      repositoryId: "repo-1",
      worktreeId: "wt-1",
    });
  });

  it("rejects save requests that escape the worktree root", async () => {
    const worktreePath = path.join(tempRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });
    getWorktreeById.mockResolvedValueOnce(buildWorktree(worktreePath));

    const response = await app.inject({
      method: "PUT",
      url: "/api/worktrees/wt-1/files/content",
      payload: {
        path: "../outside.ts",
        content: "export const nope = true;\n",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Path must be inside the selected worktree" });
  });
});
