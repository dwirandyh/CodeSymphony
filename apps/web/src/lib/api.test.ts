import { describe, it, expect, beforeEach, vi } from "vitest";
import { TeardownFailedError } from "./api";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function mockOk(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data }),
  } as Response);
}

function mockError(status: number, error: string) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({ error }),
  } as Response);
}

function mock204() {
  return Promise.resolve({
    ok: true,
    status: 204,
    json: () => Promise.resolve(null),
  } as Response);
}

describe("api", () => {
  let api: typeof import("./api").api;

  beforeEach(async () => {
    vi.resetModules();
    mockFetch.mockReset();
    const mod = await import("./api");
    api = mod.api;
  });

  describe("listRepositories", () => {
    it("fetches repositories list", async () => {
      const repos = [{ id: "r1", name: "test" }];
      mockFetch.mockReturnValueOnce(mockOk(repos));
      const result = await api.listRepositories();
      expect(result).toEqual(repos);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/repositories"),
        expect.objectContaining({ headers: expect.any(Headers) }),
      );
    });
  });

  describe("getRepository", () => {
    it("fetches single repository", async () => {
      const repo = { id: "r1", name: "test" };
      mockFetch.mockReturnValueOnce(mockOk(repo));
      const result = await api.getRepository("r1");
      expect(result).toEqual(repo);
    });
  });

  describe("createRepository", () => {
    it("posts new repository", async () => {
      const newRepo = { id: "r1", name: "new-repo" };
      mockFetch.mockReturnValueOnce(mockOk(newRepo));
      const result = await api.createRepository({ path: "/tmp/new-repo" });
      expect(result).toEqual(newRepo);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/repositories");
      expect(init.method).toBe("POST");
    });
  });

  describe("updateRepositoryScripts", () => {
    it("patches repository scripts", async () => {
      const updated = { id: "r1" };
      mockFetch.mockReturnValueOnce(mockOk(updated));
      await api.updateRepositoryScripts("r1", { setupScript: ["npm install"] });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/repositories/r1/scripts");
      expect(init.method).toBe("PATCH");
    });
  });

  describe("listBranches", () => {
    it("fetches branches", async () => {
      mockFetch.mockReturnValueOnce(mockOk(["main", "dev"]));
      const result = await api.listBranches("r1");
      expect(result).toEqual(["main", "dev"]);
    });
  });

  describe("deleteRepository", () => {
    it("deletes repository", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.deleteRepository("r1");
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/repositories/r1");
      expect(init.method).toBe("DELETE");
    });

    it("throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(500, "Server error"));
      await expect(api.deleteRepository("r1")).rejects.toThrow("Server error");
    });
  });

  describe("createWorktree", () => {
    it("creates worktree and returns it", async () => {
      const worktree = { id: "w1", branch: "feature" };
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ data: worktree }),
        }),
      );
      const result = await api.createWorktree("r1", { branch: "feature" });
      expect(result.worktree).toEqual(worktree);
    });

    it("includes script result if present", async () => {
      const worktree = { id: "w1" };
      const scriptResult = { success: true, output: "ok" };
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ data: worktree, scriptResult }),
        }),
      );
      const result = await api.createWorktree("r1");
      expect(result.scriptResult).toEqual(scriptResult);
    });

    it("throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(400, "Bad branch"));
      await expect(api.createWorktree("r1", { branch: "bad" })).rejects.toThrow("Bad branch");
    });
  });

  describe("deleteWorktree", () => {
    it("deletes worktree", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.deleteWorktree("w1");
    });

    it("passes force flag", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.deleteWorktree("w1", { force: true });
      expect(mockFetch.mock.calls[0][0]).toContain("force=true");
    });

    it("throws TeardownFailedError on 409", async () => {
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: false, status: 409,
          json: () => Promise.resolve({ output: "script failed" }),
        }),
      );
      await expect(api.deleteWorktree("w1")).rejects.toThrow("Teardown scripts failed");
    });
  });

  describe("getWorktree", () => {
    it("fetches worktree", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ id: "w1" }));
      const result = await api.getWorktree("w1");
      expect(result).toEqual({ id: "w1" });
    });
  });

  describe("renameWorktreeBranch", () => {
    it("renames branch", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ id: "w1", branch: "new-name" }));
      await api.renameWorktreeBranch("w1", { branch: "new-name" });
      const [, init] = mockFetch.mock.calls[0];
      expect(init.method).toBe("PATCH");
    });
  });

  describe("thread operations", () => {
    it("lists threads", async () => {
      mockFetch.mockReturnValueOnce(mockOk([{ id: "t1" }]));
      const result = await api.listThreads("w1");
      expect(result).toEqual([{ id: "t1" }]);
    });

    it("creates thread", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ id: "t1" }));
      const result = await api.createThread("w1");
      expect(result).toEqual({ id: "t1" });
    });

    it("gets or creates PR/MR thread", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ id: "t1" }));
      const result = await api.getOrCreatePrMrThread("w1", { permissionMode: "full_access" });
      expect(result).toEqual({ id: "t1" });
      expect(mockFetch.mock.calls[0]?.[0]).toContain("/worktrees/w1/pr-mr-thread");
      expect(mockFetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ permissionMode: "full_access" }));
    });

    it("gets thread", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ id: "t1" }));
      const result = await api.getThread("t1");
      expect(result).toEqual({ id: "t1" });
    });

    it("renames thread title", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ id: "t1", title: "New" }));
      await api.renameThreadTitle("t1", { title: "New" });
    });

    it("updates thread mode", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ id: "t1", mode: "plan" }));
      await api.updateThreadMode("t1", { mode: "plan" });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/threads/t1/mode");
      expect(init.method).toBe("PATCH");
      expect(init.body).toBe(JSON.stringify({ mode: "plan" }));
    });

    it("updates thread permission mode", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ id: "t1", permissionMode: "full_access" }));
      await api.updateThreadPermissionMode("t1", { permissionMode: "full_access" });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/threads/t1/permission-mode");
      expect(init.method).toBe("PATCH");
      expect(init.body).toBe(JSON.stringify({ permissionMode: "full_access" }));
    });

    it("deletes thread", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.deleteThread("t1");
    });

    it("delete thread throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(500, "fail"));
      await expect(api.deleteThread("t1")).rejects.toThrow("fail");
    });
  });

  describe("messages", () => {
    it("lists messages", async () => {
      mockFetch.mockReturnValueOnce(mockOk([]));
      const result = await api.listMessages("t1");
      expect(result).toEqual([]);
      expect(mockFetch.mock.calls[0][0]).toContain("/threads/t1/messages");
    });

    it("gets thread snapshot", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ messages: [], events: [], timeline: {} }));
      const result = await api.getThreadSnapshot("t1");
      expect(result).toBeTruthy();
    });

    it("sends message", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ id: "m1" }));
      await api.sendMessage("t1", { content: "hello", mode: "default", attachments: [] });
      const [, init] = mockFetch.mock.calls[0];
      expect(init.method).toBe("POST");
    });
  });

  describe("stop run", () => {
    it("stops run", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.stopRun("t1");
    });

    it("throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(500, "fail"));
      await expect(api.stopRun("t1")).rejects.toThrow("fail");
    });
  });

  describe("question operations", () => {
    it("answers question", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.answerQuestion("t1", { requestId: "q1", answers: { "0": "yes" } });
    });

    it("dismisses question", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.dismissQuestion("t1", { requestId: "q1" });
    });

    it("answer throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(400, "bad"));
      await expect(api.answerQuestion("t1", { requestId: "q1", answers: {} })).rejects.toThrow("bad");
    });
  });

  describe("permission operations", () => {
    it("resolves permission", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.resolvePermission("t1", { requestId: "p1", decision: "allow" });
    });

    it("throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(400, "fail"));
      await expect(api.resolvePermission("t1", { requestId: "p1", decision: "allow" })).rejects.toThrow("fail");
    });
  });

  describe("plan operations", () => {
    it("approves plan", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.approvePlan("t1");
    });

    it("revises plan", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.revisePlan("t1", { feedback: "Needs more detail" });
    });

    it("approve throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(400, "fail"));
      await expect(api.approvePlan("t1")).rejects.toThrow("fail");
    });

    it("revise throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(400, "fail"));
      await expect(api.revisePlan("t1", { feedback: "more" })).rejects.toThrow("fail");
    });
  });

  describe("events", () => {
    it("gets timeline snapshot", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ timelineItems: [], events: [], messages: [] }));
      const result = await api.getTimelineSnapshot("t1");
      expect(result).toBeTruthy();
    });

    it("sends expectedWorktreeId with chat messages", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ id: "m1" }));
      await api.sendMessage("t1", {
        content: "hello",
        mode: "default",
        attachments: [],
        expectedWorktreeId: "w1",
      });
      expect(String(mockFetch.mock.calls[0]?.[1]?.body)).toContain('"expectedWorktreeId":"w1"');
    });
  });

  describe("git operations", () => {
    it("gets git status", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0, entries: [] }));
      await api.getGitStatus("w1");
    });

    it("gets git branch diff summary", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ branch: "feature-x", baseBranch: "main", insertions: 10, deletions: 2, filesChanged: 1, available: true }));
      await api.getGitBranchDiffSummary("w1");
      expect(mockFetch.mock.calls[0][0]).toContain("/worktrees/w1/git/branch-diff-summary");
    });

    it("gets git diff", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ diff: "" }));
      await api.getGitDiff("w1", { filePath: "src/a.ts" });
      expect(mockFetch.mock.calls[0][0]).toContain("filePath=");
    });

    it("gets file contents", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ oldContent: "a", newContent: "b" }));
      await api.getFileContents("w1", "src/a.ts");
    });

    it("commits", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ result: "ok" }));
      await api.gitCommit("w1", { message: "test" });
    });

    it("syncs branch", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ result: "ok" }));
      await api.gitSync("w1");
      expect(mockFetch.mock.calls[0][0]).toContain("/worktrees/w1/git/sync");
    });

    it("discards change", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.discardGitChange("w1", "src/a.ts");
    });

    it("discard throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(500, "fail"));
      await expect(api.discardGitChange("w1", "src/a.ts")).rejects.toThrow("fail");
    });
  });

  describe("file operations", () => {
    it("searches files", async () => {
      mockFetch.mockReturnValueOnce(mockOk([]));
      await api.searchFiles("w1", "*.ts");
    });

    it("gets file index", async () => {
      mockFetch.mockReturnValueOnce(mockOk([]));
      await api.getFileIndex("w1");
    });

    it("gets slash commands", async () => {
      mockFetch.mockReturnValueOnce(mockOk({
        commands: [{ name: "commit", description: "Create a commit", argumentHint: "" }],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }));
      await api.getSlashCommands("w1");
    });

    it("gets worktree file content", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ path: "src/a.ts", content: "const a = 1;" }));
      await api.getWorktreeFileContent("w1", "src/a.ts");
      expect(mockFetch.mock.calls[0][0]).toContain("/worktrees/w1/files/content?path=");
    });

    it("saves worktree file content", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ path: "src/a.ts", content: "const a = 2;" }));
      await api.saveWorktreeFileContent("w1", { path: "src/a.ts", content: "const a = 2;" });
      expect(String(mockFetch.mock.calls[0]?.[1]?.body)).toContain('"content":"const a = 2;"');
    });

    it("opens worktree file", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.openWorktreeFile("w1", { path: "src/a.ts" });
    });

    it("open file throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(500, "fail"));
      await expect(api.openWorktreeFile("w1", { path: "src/a.ts" })).rejects.toThrow("fail");
    });
  });

  describe("system operations", () => {
    it("picks directory", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ path: "/home" }));
      const result = await api.pickDirectory();
      expect(result.path).toBe("/home");
    });

    it("browses filesystem", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ entries: [] }));
      await api.browseFilesystem("/home");
    });

    it("gets installed apps", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ apps: [{ id: "1", name: "VSCode" }] }));
      const result = await api.getInstalledApps();
      expect(result[0].name).toBe("VSCode");
    });

    it("opens in app", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.openInApp({ appId: "1", targetPath: "/home" });
    });

    it("open in app throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(500, "fail"));
      await expect(api.openInApp({ appId: "1", targetPath: "/" })).rejects.toThrow("fail");
    });
  });

  describe("model provider operations", () => {
    it("lists providers", async () => {
      mockFetch.mockReturnValueOnce(mockOk([]));
      await api.listModelProviders();
    });

    it("creates provider", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ id: "p1" }));
      await api.createModelProvider({ name: "test", modelId: "m1", baseUrl: "http://localhost", apiKey: "key" });
    });

    it("updates provider", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ id: "p1" }));
      await api.updateModelProvider("p1", { name: "updated" });
    });

    it("deletes provider", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.deleteModelProvider("p1");
    });

    it("delete provider throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(500, "fail"));
      await expect(api.deleteModelProvider("p1")).rejects.toThrow("fail");
    });

    it("activates provider", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ id: "p1" }));
      await api.activateModelProvider("p1");
    });

    it("deactivates all providers", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.deactivateAllProviders();
    });

    it("deactivate throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(500, "fail"));
      await expect(api.deactivateAllProviders()).rejects.toThrow("fail");
    });

    it("tests provider", async () => {
      mockFetch.mockReturnValueOnce(mockOk({ success: true }));
      const result = await api.testModelProvider({ baseUrl: "http://localhost", apiKey: "key", modelId: "m1" });
      expect(result.success).toBe(true);
    });
  });

  describe("terminal operations", () => {
    it("runs terminal command", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.runTerminalCommand({ sessionId: "s1", command: "ls" });
    });

    it("run command throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(500, "fail"));
      await expect(api.runTerminalCommand({ sessionId: "s1", command: "ls" })).rejects.toThrow("fail");
    });

    it("interrupts terminal session", async () => {
      mockFetch.mockReturnValueOnce(mock204());
      await api.interruptTerminalSession("s1");
    });

    it("interrupt throws on error", async () => {
      mockFetch.mockReturnValueOnce(mockError(500, "fail"));
      await expect(api.interruptTerminalSession("s1")).rejects.toThrow("fail");
    });
  });

  describe("runtimeBaseUrl", () => {
    it("strips /api suffix", () => {
      expect(api.runtimeBaseUrl).not.toContain("/api");
    });
  });

  describe("error handling", () => {
    it("throws on unexpected response shape", async () => {
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: true,
          status: 200,
          url: "http://localhost:5173/api/repositories",
          headers: new Headers({ "content-type": "text/html" }),
          json: () => Promise.resolve({ unexpected: true }),
          clone: () => ({ text: () => Promise.resolve("<html><body>oops</body></html>") }),
        }),
      );
      const result = api.listRepositories();
      await expect(result).rejects.toThrow("unexpected response shape");
      await expect(result).rejects.toThrow("content-type=text/html");
    });

    it("throws runtime unavailable when all bases fail", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));
      await expect(api.listRepositories()).rejects.toThrow("Runtime API unavailable");
    });

    it("resolves the runtime base lazily after the module loads", async () => {
      vi.stubGlobal("window", {
        __CS_RUNTIME_PORT: 4322,
        __TAURI_INTERNALS__: {},
        location: {
          protocol: "http:",
          hostname: "127.0.0.1",
          origin: "http://127.0.0.1:5174",
          port: "5174",
        },
      } as Window);

      mockFetch.mockReturnValueOnce(mockOk([]));
      await api.listRepositories();

      expect(String(mockFetch.mock.calls[0]?.[0])).toContain("http://127.0.0.1:4322/api/repositories");
    });

    it("rethrows AbortError as-is", async () => {
      const abortError = new DOMException("Aborted", "AbortError");
      mockFetch.mockRejectedValue(abortError);
      await expect(api.listRepositories()).rejects.toThrow("Aborted");
    });

    it("handles json parse failure on error response", async () => {
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: false, status: 500,
          json: () => Promise.reject(new Error("parse fail")),
        }),
      );
      await expect(api.listRepositories()).rejects.toThrow("Request failed");
    });
  });
});

describe("TeardownFailedError", () => {
  it("has correct name and output", () => {
    const error = new TeardownFailedError("script output");
    expect(error.name).toBe("TeardownFailedError");
    expect(error.output).toBe("script output");
    expect(error.message).toBe("Teardown scripts failed");
  });
});
