import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createWorktreeService, isDefaultBranchName, TeardownError } from "../src/services/worktreeService";

let prisma: PrismaClient;
let repoDir: string;
let repositoryId: string;

function git(args: string, cwd = repoDir) {
  execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: "pipe" });
}

beforeAll(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: "file:./test.db" } } });
  await prisma.$connect();

  repoDir = await mkdtemp(join(tmpdir(), "cs-wt-svc-test-"));
  git("init --initial-branch=main");
  git('config user.email "test@test.com"');
  git('config user.name "Test"');
  await writeFile(join(repoDir, "README.md"), "# Hello");
  git("add -A");
  git('commit -m "init"');

  const repo = await prisma.repository.create({
    data: {
      name: "test-repo",
      rootPath: repoDir,
      defaultBranch: "main",
    },
  });
  repositoryId = repo.id;

  await prisma.worktree.create({
    data: {
      repositoryId: repo.id,
      branch: "main",
      path: repoDir,
      baseBranch: "main",
      status: "active",
    },
  });
});

afterAll(async () => {
  await prisma.chatEvent.deleteMany({});
  await prisma.chatMessage.deleteMany({});
  await prisma.chatThread.deleteMany({});
  await prisma.worktree.deleteMany({});
  await prisma.repository.deleteMany({});
  await prisma.$disconnect();
  await rm(repoDir, { recursive: true, force: true });
});

describe("isDefaultBranchName", () => {
  it("returns true for Indonesian province slug", () => {
    expect(isDefaultBranchName("aceh")).toBe(true);
    expect(isDefaultBranchName("bali")).toBe(true);
    expect(isDefaultBranchName("jakarta")).toBe(true);
  });

  it("returns true for province slug with cycle suffix", () => {
    expect(isDefaultBranchName("aceh-2")).toBe(true);
    expect(isDefaultBranchName("bali-3")).toBe(true);
  });

  it("returns false for non-province branch names", () => {
    expect(isDefaultBranchName("main")).toBe(false);
    expect(isDefaultBranchName("feature-branch")).toBe(false);
    expect(isDefaultBranchName("")).toBe(false);
  });
});

describe("worktreeService", () => {
  const service = createWorktreeService(new PrismaClient({ datasources: { db: { url: "file:./test.db" } } }));
  const createdWorktreeIds: string[] = [];

  afterEach(async () => {
    for (const id of createdWorktreeIds) {
      try {
        await service.remove(id, { force: true });
      } catch {
        // already removed
      }
    }
    createdWorktreeIds.length = 0;
  });

  afterAll(async () => {
    for (const id of createdWorktreeIds) {
      try {
        await service.remove(id, { force: true });
      } catch {
        // cleanup
      }
    }
  });

  describe("create", () => {
    it("creates a worktree with automatic branch name", async () => {
      const result = await service.create(repositoryId, {});
      createdWorktreeIds.push(result.worktree.id);

      expect(result.worktree.id).toBeDefined();
      expect(result.worktree.branch).toBeTruthy();
      expect(isDefaultBranchName(result.worktree.branch)).toBe(true);
    });

    it("creates a worktree with specified branch name", async () => {
      const result = await service.create(repositoryId, { branch: "feature-test-x" });
      createdWorktreeIds.push(result.worktree.id);

      expect(result.worktree.branch).toBe("feature-test-x");
    });

    it("throws for non-existent repository", async () => {
      await expect(service.create("non-existent-id", {})).rejects.toThrow("Repository not found");
    });

    it("throws for duplicate branch name", async () => {
      const result = await service.create(repositoryId, { branch: "dup-branch-test" });
      createdWorktreeIds.push(result.worktree.id);

      await expect(
        service.create(repositoryId, { branch: "dup-branch-test" })
      ).rejects.toThrow("Branch already has a worktree");
    });
  });

  describe("getById", () => {
    it("returns a worktree by id", async () => {
      const created = await service.create(repositoryId, { branch: "getbyid-test" });
      createdWorktreeIds.push(created.worktree.id);

      const found = await service.getById(created.worktree.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.worktree.id);
    });

    it("returns null for non-existent id", async () => {
      const found = await service.getById("non-existent-id");
      expect(found).toBeNull();
    });
  });

  describe("remove", () => {
    it("removes a worktree successfully", async () => {
      const created = await service.create(repositoryId, { branch: "to-remove-test" });

      await service.remove(created.worktree.id);
      const found = await service.getById(created.worktree.id);
      expect(found).toBeNull();
    });

    it("throws when trying to remove primary worktree", async () => {
      const root = await prisma.worktree.findFirst({
        where: { repositoryId, path: repoDir },
      });
      if (root) {
        await expect(service.remove(root.id)).rejects.toThrow("Cannot delete primary worktree");
      }
    });

    it("throws for non-existent worktree", async () => {
      await expect(service.remove("non-existent")).rejects.toThrow("Worktree not found");
    });
  });

  describe("renameBranch", () => {
    it("renames a worktree branch", async () => {
      const created = await service.create(repositoryId, { branch: "rename-src" });
      createdWorktreeIds.push(created.worktree.id);

      const renamed = await service.renameBranch(created.worktree.id, "rename-dest");
      expect(renamed.branch).toBe("rename-dest");
    });

    it("returns same worktree when new name matches current", async () => {
      const created = await service.create(repositoryId, { branch: "same-name" });
      createdWorktreeIds.push(created.worktree.id);

      const result = await service.renameBranch(created.worktree.id, "same-name");
      expect(result.branch).toBe("same-name");
    });

    it("throws for non-existent worktree", async () => {
      await expect(
        service.renameBranch("non-existent", "new-name")
      ).rejects.toThrow("Worktree not found");
    });
  });

  describe("rerunSetup", () => {
    it("returns success when no setup script configured", async () => {
      const created = await service.create(repositoryId, { branch: "setup-test" });
      createdWorktreeIds.push(created.worktree.id);

      const result = await service.rerunSetup(created.worktree.id);
      expect(result.success).toBe(true);
      expect(result.output).toContain("No setup scripts");
    });

    it("throws for non-existent worktree", async () => {
      await expect(service.rerunSetup("non-existent")).rejects.toThrow("Worktree not found");
    });
  });

  describe("getSetupContext", () => {
    it("returns null for non-existent worktree", async () => {
      const result = await service.getSetupContext("non-existent");
      expect(result).toBeNull();
    });

    it("returns null when no setup script configured", async () => {
      const created = await service.create(repositoryId, { branch: "ctx-test" });
      createdWorktreeIds.push(created.worktree.id);

      const result = await service.getSetupContext(created.worktree.id);
      expect(result).toBeNull();
    });
  });

  describe("getRunScriptContext", () => {
    it("returns null for non-existent worktree", async () => {
      const result = await service.getRunScriptContext("non-existent");
      expect(result).toBeNull();
    });

    it("returns null when no run script configured", async () => {
      const created = await service.create(repositoryId, { branch: "run-ctx-test" });
      createdWorktreeIds.push(created.worktree.id);

      const result = await service.getRunScriptContext(created.worktree.id);
      expect(result).toBeNull();
    });
  });

  describe("listThreads", () => {
    it("returns threads for a worktree", async () => {
      const created = await service.create(repositoryId, { branch: "threads-test" });
      createdWorktreeIds.push(created.worktree.id);

      const threads = await service.listThreads(created.worktree.id);
      expect(threads.length).toBeGreaterThanOrEqual(1);
    });
  });
});
