import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRepositoryRoutes } from "../src/routes/repositories";

const mockRepoService = {
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  updateScripts: vi.fn(),
  listBranches: vi.fn(),
  remove: vi.fn(),
};

const mockWorktreeService = {
  create: vi.fn(),
  getById: vi.fn(),
  remove: vi.fn(),
  listThreads: vi.fn(),
  renameBranch: vi.fn(),
};

const mockReviewService = {
  getRepositoryReviews: vi.fn(),
};


const mockFileService = {
  searchFiles: vi.fn(),
  listFileIndex: vi.fn(),
};

const mockSystemService = {
  pickDirectory: vi.fn(),
  openFileDefaultApp: vi.fn(),
};

const mockChatService = {
  generateCommitMessage: vi.fn(),
  getOrCreatePrMrThread: vi.fn(),
};

const mockScriptStreamService = {
  startSetupStream: vi.fn(),
  stopScript: vi.fn(),
};

vi.mock("../src/services/git.js", () => ({
  getGitStatus: vi.fn().mockResolvedValue({ entries: [], branch: "main" }),
  getGitDiff: vi.fn().mockResolvedValue("diff output"),
  getFileAtHead: vi.fn().mockResolvedValue("old content"),
  gitCommitAll: vi.fn().mockResolvedValue("abc123"),
  discardGitChange: vi.fn().mockResolvedValue(undefined),
}));

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorate("repositoryService", mockRepoService as never);
  app.decorate("worktreeService", mockWorktreeService as never);
  app.decorate("fileService", mockFileService as never);
  app.decorate("systemService", mockSystemService as never);
  app.decorate("chatService", mockChatService as never);
  app.decorate("scriptStreamService", mockScriptStreamService as never);
  app.decorate("reviewService", mockReviewService as never);
  return app;
}

describe("repository routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockReviewService.getRepositoryReviews.mockReset();
    mockChatService.getOrCreatePrMrThread.mockReset();
    app = buildApp();
    await app.register(registerRepositoryRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /api/repositories", () => {
    it("lists repositories", async () => {
      mockRepoService.list.mockResolvedValue([{ id: "r1", name: "test" }]);
      const res = await app.inject({ method: "GET", url: "/api/repositories" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([{ id: "r1", name: "test" }]);
    });
  });

  describe("GET /api/repositories/:id", () => {
    it("returns repository", async () => {
      mockRepoService.getById.mockResolvedValue({ id: "r1", name: "test" });
      const res = await app.inject({ method: "GET", url: "/api/repositories/r1" });
      expect(res.statusCode).toBe(200);
    });

    it("returns 404 when not found", async () => {
      mockRepoService.getById.mockResolvedValue(null);
      const res = await app.inject({ method: "GET", url: "/api/repositories/unknown" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/repositories", () => {
    it("creates repository", async () => {
      mockRepoService.create.mockResolvedValue({ id: "r1", name: "new" });
      const res = await app.inject({
        method: "POST",
        url: "/api/repositories",
        payload: { path: "/tmp/new-repo" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("returns 400 on error", async () => {
      mockRepoService.create.mockRejectedValue(new Error("Not a git repo"));
      const res = await app.inject({
        method: "POST",
        url: "/api/repositories",
        payload: { path: "/nonexistent" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PATCH /api/repositories/:id/scripts", () => {
    it("updates scripts", async () => {
      mockRepoService.updateScripts.mockResolvedValue({ id: "r1" });
      const res = await app.inject({
        method: "PATCH",
        url: "/api/repositories/r1/scripts",
        payload: { setupScript: ["npm install"] },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("GET /api/repositories/:id/branches", () => {
    it("lists branches", async () => {
      mockRepoService.listBranches.mockResolvedValue(["main", "dev"]);
      const res = await app.inject({ method: "GET", url: "/api/repositories/r1/branches" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual(["main", "dev"]);
    });

    it("returns 404 when repo not found", async () => {
      mockRepoService.listBranches.mockRejectedValue(new Error("Repository not found"));
      const res = await app.inject({ method: "GET", url: "/api/repositories/r1/branches" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/repositories/:id/reviews", () => {
    it("returns repository review state", async () => {
      mockReviewService.getRepositoryReviews.mockResolvedValue({
        provider: "github",
        kind: "pr",
        available: true,
        reviewsByBranch: {
          "feature-x": { number: 123, display: "#123", url: "https://example.com/pr/123", state: "open" },
        },
      });
      const res = await app.inject({ method: "GET", url: "/api/repositories/r1/reviews" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.reviewsByBranch["feature-x"].display).toBe("#123");
      expect(res.json().data.reviewsByBranch["feature-x"].state).toBe("open");
    });

    it("returns cached review state for repeated requests within ttl", async () => {
      const repositoryId = `repo-cache-${Date.now()}`;
      mockReviewService.getRepositoryReviews.mockResolvedValue({
        provider: "github",
        kind: "pr",
        available: true,
        reviewsByBranch: {},
      });

      const first = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/reviews` });
      const second = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/reviews` });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(mockReviewService.getRepositoryReviews).toHaveBeenCalledTimes(1);
    });

    it("returns 404 when repository not found", async () => {
      mockReviewService.getRepositoryReviews.mockRejectedValue(new Error("Repository not found"));
      const res = await app.inject({ method: "GET", url: "/api/repositories/r2/reviews" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/worktrees/:id/pr-mr-thread", () => {
    it("returns existing or created PR/MR thread", async () => {
      mockChatService.getOrCreatePrMrThread.mockResolvedValue({
        id: "thread-review",
        worktreeId: "w1",
        title: "PR / MR",
        kind: "review",
        permissionProfile: "review_git",
        titleEditedManually: false,
        claudeSessionId: null,
        active: false,
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:00.000Z",
      });

      const res = await app.inject({ method: "POST", url: "/api/worktrees/w1/pr-mr-thread" });
      expect(res.statusCode).toBe(201);
      expect(mockChatService.getOrCreatePrMrThread).toHaveBeenCalledWith("w1");
      expect(res.json().data.kind).toBe("review");
      expect(res.json().data.permissionProfile).toBe("review_git");
    });

    it("returns 404 when worktree is missing", async () => {
      mockChatService.getOrCreatePrMrThread.mockRejectedValue(new Error("Worktree not found"));
      const res = await app.inject({ method: "POST", url: "/api/worktrees/missing/pr-mr-thread" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("DELETE /api/repositories/:id", () => {
    it("deletes repository", async () => {
      mockRepoService.getById.mockResolvedValue({ id: "r1", worktrees: [] });
      mockRepoService.remove.mockResolvedValue(undefined);
      const res = await app.inject({ method: "DELETE", url: "/api/repositories/r1" });
      expect(res.statusCode).toBe(204);
    });

    it("returns 404 when not found", async () => {
      mockRepoService.getById.mockResolvedValue(null);
      const res = await app.inject({ method: "DELETE", url: "/api/repositories/unknown" });
      expect(res.statusCode).toBe(404);
    });

    it("force-removes worktrees first", async () => {
      mockRepoService.getById.mockResolvedValue({
        id: "r1",
        worktrees: [{ id: "w1" }, { id: "w2" }],
      });
      mockRepoService.remove.mockResolvedValue(undefined);
      mockWorktreeService.remove.mockResolvedValue(undefined);
      await app.inject({ method: "DELETE", url: "/api/repositories/r1" });
      expect(mockWorktreeService.remove).toHaveBeenCalledTimes(2);
    });
  });

  describe("POST /api/repositories/:id/worktrees", () => {
    it("creates worktree", async () => {
      mockWorktreeService.create.mockResolvedValue({ worktree: { id: "w1" } });
      const res = await app.inject({
        method: "POST",
        url: "/api/repositories/r1/worktrees",
        payload: {},
      });
      expect(res.statusCode).toBe(201);
    });
  });

  describe("GET /api/worktrees/:id", () => {
    it("returns worktree", async () => {
      mockWorktreeService.getById.mockResolvedValue({ id: "w1" });
      const res = await app.inject({ method: "GET", url: "/api/worktrees/w1" });
      expect(res.statusCode).toBe(200);
    });

    it("returns 404 when not found", async () => {
      mockWorktreeService.getById.mockResolvedValue(null);
      const res = await app.inject({ method: "GET", url: "/api/worktrees/unknown" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("DELETE /api/worktrees/:id", () => {
    it("deletes worktree", async () => {
      mockWorktreeService.remove.mockResolvedValue(undefined);
      const res = await app.inject({ method: "DELETE", url: "/api/worktrees/w1" });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("PATCH /api/worktrees/:id/branch", () => {
    it("renames branch", async () => {
      mockWorktreeService.renameBranch.mockResolvedValue({ id: "w1", branch: "new-name" });
      const res = await app.inject({
        method: "PATCH",
        url: "/api/worktrees/w1/branch",
        payload: { branch: "new-name" },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("GET /api/worktrees/:id/files", () => {
    it("searches files", async () => {
      mockWorktreeService.getById.mockResolvedValue({ id: "w1", path: "/tmp/wt" });
      mockFileService.searchFiles.mockResolvedValue([{ path: "index.ts", type: "file" }]);
      const res = await app.inject({ method: "GET", url: "/api/worktrees/w1/files?q=index" });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("GET /api/worktrees/:id/files/index", () => {
    it("returns file index", async () => {
      mockWorktreeService.getById.mockResolvedValue({ id: "w1", path: "/tmp/wt" });
      mockFileService.listFileIndex.mockResolvedValue([]);
      const res = await app.inject({ method: "GET", url: "/api/worktrees/w1/files/index" });
      expect(res.statusCode).toBe(200);
    });

    it("returns 404 when worktree not found", async () => {
      mockWorktreeService.getById.mockResolvedValue(null);
      const res = await app.inject({ method: "GET", url: "/api/worktrees/xxx/files/index" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/worktrees/:id/git/status", () => {
    it("returns git status", async () => {
      mockWorktreeService.getById.mockResolvedValue({ id: "w1", path: "/tmp/wt" });
      const res = await app.inject({ method: "GET", url: "/api/worktrees/w1/git/status" });
      expect(res.statusCode).toBe(200);
    });

    it("returns 404 when worktree not found", async () => {
      mockWorktreeService.getById.mockResolvedValue(null);
      const res = await app.inject({ method: "GET", url: "/api/worktrees/xxx/git/status" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/worktrees/:id/git/diff", () => {
    it("returns git diff", async () => {
      mockWorktreeService.getById.mockResolvedValue({ id: "w1", path: "/tmp/wt" });
      const res = await app.inject({ method: "GET", url: "/api/worktrees/w1/git/diff" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.diff).toBe("diff output");
    });

    it("passes filePath query", async () => {
      mockWorktreeService.getById.mockResolvedValue({ id: "w1", path: "/tmp/wt" });
      const res = await app.inject({
        method: "GET",
        url: "/api/worktrees/w1/git/diff?filePath=src/index.ts",
      });
      expect(res.statusCode).toBe(200);
    });

    it("returns 404 when worktree not found", async () => {
      mockWorktreeService.getById.mockResolvedValue(null);
      const res = await app.inject({ method: "GET", url: "/api/worktrees/xxx/git/diff" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/worktrees/:id/git/file-contents", () => {
    it("returns old and new file contents", async () => {
      mockWorktreeService.getById.mockResolvedValue({ id: "w1", path: "/tmp/wt" });
      const res = await app.inject({
        method: "GET",
        url: "/api/worktrees/w1/git/file-contents?path=src/test.ts",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.oldContent).toBe("old content");
    });

    it("returns 404 when worktree not found", async () => {
      mockWorktreeService.getById.mockResolvedValue(null);
      const res = await app.inject({
        method: "GET",
        url: "/api/worktrees/xxx/git/file-contents?path=file.ts",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/worktrees/:id/git/commit", () => {
    it("commits with provided message", async () => {
      mockWorktreeService.getById.mockResolvedValue({ id: "w1", path: "/tmp/wt" });
      const res = await app.inject({
        method: "POST",
        url: "/api/worktrees/w1/git/commit",
        payload: { message: "fix: bug" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("generates commit message when empty", async () => {
      mockWorktreeService.getById.mockResolvedValue({ id: "w1", path: "/tmp/wt" });
      mockChatService.generateCommitMessage.mockResolvedValue("auto: generated message");
      const res = await app.inject({
        method: "POST",
        url: "/api/worktrees/w1/git/commit",
        payload: { message: "" },
      });
      expect(res.statusCode).toBe(200);
      expect(mockChatService.generateCommitMessage).toHaveBeenCalled();
    });

    it("returns 404 when worktree not found", async () => {
      mockWorktreeService.getById.mockResolvedValue(null);
      const res = await app.inject({
        method: "POST",
        url: "/api/worktrees/xxx/git/commit",
        payload: { message: "msg" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/worktrees/:id/git/discard", () => {
    it("discards a file change", async () => {
      mockWorktreeService.getById.mockResolvedValue({ id: "w1", path: "/tmp/wt" });
      const res = await app.inject({
        method: "POST",
        url: "/api/worktrees/w1/git/discard",
        payload: { filePath: "src/test.ts" },
      });
      expect(res.statusCode).toBe(204);
    });

    it("returns 404 when worktree not found", async () => {
      mockWorktreeService.getById.mockResolvedValue(null);
      const res = await app.inject({
        method: "POST",
        url: "/api/worktrees/xxx/git/discard",
        payload: { filePath: "file.ts" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/worktrees/:id/run-setup", () => {
    it("reruns setup", async () => {
      mockWorktreeService.rerunSetup = vi.fn().mockResolvedValue({ success: true, output: "done" });
      const res = await app.inject({
        method: "POST",
        url: "/api/worktrees/w1/run-setup",
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("POST /api/worktrees/:id/run-setup/stop", () => {
    it("stops setup script", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/worktrees/w1/run-setup/stop",
      });
      expect(res.statusCode).toBe(204);
      expect(mockScriptStreamService.stopScript).toHaveBeenCalledWith("w1");
    });
  });

  describe("POST /api/worktrees/:id/run-script/stop", () => {
    it("stops run script", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/worktrees/w1/run-script/stop",
      });
      expect(res.statusCode).toBe(204);
      expect(mockScriptStreamService.stopScript).toHaveBeenCalledWith("run:w1");
    });
  });

  describe("DELETE /api/worktrees/:id (force)", () => {
    it("force-deletes a worktree", async () => {
      mockWorktreeService.remove.mockResolvedValue(undefined);
      const res = await app.inject({
        method: "DELETE",
        url: "/api/worktrees/w1?force=true",
      });
      expect(res.statusCode).toBe(204);
      expect(mockWorktreeService.remove).toHaveBeenCalledWith("w1", { force: true });
    });
  });

  describe("GET /api/worktrees/:id/files (not found)", () => {
    it("returns 404 when worktree not found", async () => {
      mockWorktreeService.getById.mockResolvedValue(null);
      const res = await app.inject({ method: "GET", url: "/api/worktrees/xxx/files?q=test" });
      expect(res.statusCode).toBe(404);
    });
  });
});
