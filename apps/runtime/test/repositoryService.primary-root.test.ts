import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRepositoryService } from "../src/services/repositoryService";
import { createWorktreeService } from "../src/services/worktreeService";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL && process.env.DATABASE_URL.includes("test.db")
    ? process.env.DATABASE_URL
    : "file:./test.db";

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: TEST_DATABASE_URL,
    },
  },
});

const tempDirs: string[] = [];

function createGitRepository(): string {
  const repositoryPath = mkdtempSync(join(tmpdir(), "codesymphony-repository-service-"));
  tempDirs.push(repositoryPath);

  execFileSync("git", ["init", "-q"], { cwd: repositoryPath });
  execFileSync("git", ["checkout", "-b", "main"], { cwd: repositoryPath });
  execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: repositoryPath });
  execFileSync("git", ["config", "user.name", "Codesymphony Tests"], { cwd: repositoryPath });
  writeFileSync(join(repositoryPath, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: repositoryPath });
  execFileSync("git", ["commit", "-m", "Initial commit", "-q"], { cwd: repositoryPath });

  return repositoryPath;
}

async function resetDatabase(): Promise<void> {
  await prisma.chatEvent.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.chatThread.deleteMany();
  await prisma.worktree.deleteMany();
  await prisma.repository.deleteMany();
}

describe("repositoryService primary root workspace", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a primary root worktree and main thread", async () => {
    const repositoryPath = createGitRepository();
    const canonicalRepositoryPath = realpathSync(repositoryPath);
    const repositoryService = createRepositoryService(prisma);

    const created = await repositoryService.create({ path: repositoryPath });
    const rootWorktree = created.worktrees.find((worktree) => worktree.path === canonicalRepositoryPath);

    expect(rootWorktree).toBeDefined();

    const thread = await prisma.chatThread.findFirst({
      where: {
        worktreeId: rootWorktree!.id,
        title: "New Thread",
      },
    });
    expect(thread).toBeTruthy();
  });

  it("syncs worktree branch from git on repository list", async () => {
    const repositoryPath = createGitRepository();
    const canonicalRepositoryPath = realpathSync(repositoryPath);
    const repositoryService = createRepositoryService(prisma);

    const created = await repositoryService.create({ path: repositoryPath });
    const rootWorktree = created.worktrees.find((worktree) => worktree.path === canonicalRepositoryPath);
    expect(rootWorktree).toBeDefined();

    execFileSync("git", ["checkout", "-b", "feature/root-sync"], { cwd: repositoryPath });

    const listed = await repositoryService.list();
    const listedRepository = listed.find((repository) => repository.id === created.id);
    expect(listedRepository).toBeDefined();

    const listedRootWorktree = listedRepository!.worktrees.find((worktree) => worktree.id === rootWorktree!.id);
    expect(listedRootWorktree?.branch).toBe("feature/root-sync");

    const persisted = await prisma.worktree.findUnique({
      where: { id: rootWorktree!.id },
    });
    expect(persisted?.branch).toBe("feature/root-sync");
  });

  it("syncs root worktree base branch when repository default branch changes", async () => {
    const repositoryPath = createGitRepository();
    const canonicalRepositoryPath = realpathSync(repositoryPath);
    const repositoryService = createRepositoryService(prisma);

    const created = await repositoryService.create({ path: repositoryPath });
    const rootWorktree = created.worktrees.find((worktree) => worktree.path === canonicalRepositoryPath);
    expect(rootWorktree).toBeDefined();
    expect(rootWorktree?.baseBranch).toBe("main");

    const updated = await repositoryService.updateScripts(created.id, { defaultBranch: "develop" });
    const updatedRootWorktree = updated.worktrees.find((worktree) => worktree.id === rootWorktree!.id);

    expect(updated.defaultBranch).toBe("develop");
    expect(updatedRootWorktree?.baseBranch).toBe("develop");

    const persisted = await prisma.worktree.findUnique({
      where: { id: rootWorktree!.id },
    });
    expect(persisted?.baseBranch).toBe("develop");
  });

  it("persists save automation settings on repository updates", async () => {
    const repositoryPath = createGitRepository();
    const repositoryService = createRepositoryService(prisma);

    const created = await repositoryService.create({ path: repositoryPath });
    const updated = await repositoryService.updateScripts(created.id, {
      saveAutomation: {
        enabled: true,
        target: "workspace_terminal",
        filePatterns: ["lib/**/*.dart"],
        actionType: "send_stdin",
        payload: "r",
        debounceMs: 250,
      },
    });

    expect(updated.saveAutomation).toEqual({
      enabled: true,
      target: "workspace_terminal",
      filePatterns: ["lib/**/*.dart"],
      actionType: "send_stdin",
      payload: "r",
      debounceMs: 250,
    });

    const persisted = await prisma.repository.findUnique({
      where: { id: created.id },
    });

    expect(persisted?.saveAutomation).toBe(JSON.stringify({
      enabled: true,
      target: "workspace_terminal",
      filePatterns: ["lib/**/*.dart"],
      actionType: "send_stdin",
      payload: "r",
      debounceMs: 250,
    }));
  });

  it("repairs a stale root worktree base branch on repository list", async () => {
    const repositoryPath = createGitRepository();
    const canonicalRepositoryPath = realpathSync(repositoryPath);
    const repositoryService = createRepositoryService(prisma);

    const created = await repositoryService.create({ path: repositoryPath });
    const rootWorktree = created.worktrees.find((worktree) => worktree.path === canonicalRepositoryPath);
    expect(rootWorktree).toBeDefined();

    await prisma.repository.update({
      where: { id: created.id },
      data: { defaultBranch: "develop" },
    });
    await prisma.worktree.update({
      where: { id: rootWorktree!.id },
      data: { baseBranch: "main" },
    });

    const listed = await repositoryService.list();
    const listedRepository = listed.find((repository) => repository.id === created.id);
    const listedRootWorktree = listedRepository?.worktrees.find((worktree) => worktree.id === rootWorktree!.id);

    expect(listedRepository?.defaultBranch).toBe("develop");
    expect(listedRootWorktree?.baseBranch).toBe("develop");
  });

  it("blocks deleting the primary root worktree", async () => {
    const repositoryPath = createGitRepository();
    const canonicalRepositoryPath = realpathSync(repositoryPath);
    const repositoryService = createRepositoryService(prisma);
    const worktreeService = createWorktreeService(prisma);

    const created = await repositoryService.create({ path: repositoryPath });
    const rootWorktree = created.worktrees.find((worktree) => worktree.path === canonicalRepositoryPath);
    expect(rootWorktree).toBeDefined();

    await expect(worktreeService.remove(rootWorktree!.id)).rejects.toThrow("Cannot delete primary worktree");
  });

  it("recovers missing primary worktree when listing repositories", async () => {
    const repositoryPath = createGitRepository();
    const canonicalRepositoryPath = realpathSync(repositoryPath);
    const repositoryService = createRepositoryService(prisma);

    const createdRepository = await prisma.repository.create({
      data: {
        name: "orphan-repo",
        rootPath: canonicalRepositoryPath,
        defaultBranch: "main",
      },
    });

    const listed = await repositoryService.list();
    const listedRepository = listed.find((repository) => repository.id === createdRepository.id);
    expect(listedRepository).toBeDefined();
    expect(listedRepository!.worktrees.length).toBe(1);
    expect(listedRepository!.worktrees[0].path).toBe(canonicalRepositoryPath);
    expect(listedRepository!.worktrees[0].status).toBe("active");
  });

  it("recovers primary root worktree when non-root worktrees already exist", async () => {
    const repositoryPath = createGitRepository();
    const canonicalRepositoryPath = realpathSync(repositoryPath);
    const repositoryService = createRepositoryService(prisma);

    const created = await repositoryService.create({ path: repositoryPath });
    const rootWorktree = created.worktrees.find((worktree) => worktree.path === canonicalRepositoryPath);
    expect(rootWorktree).toBeDefined();

    await prisma.worktree.create({
      data: {
        repositoryId: created.id,
        branch: "feature-non-root",
        path: `${canonicalRepositoryPath}-orphan-worktree`,
        baseBranch: "main",
        status: "archived",
      },
    });
    await prisma.worktree.delete({ where: { id: rootWorktree!.id } });

    const listed = await repositoryService.list();
    const listedRepository = listed.find((repository) => repository.id === created.id);
    expect(listedRepository).toBeDefined();

    const restoredRoot = listedRepository!.worktrees.find((worktree) => worktree.path === canonicalRepositoryPath);
    expect(restoredRoot).toBeDefined();
    expect(restoredRoot!.status).toBe("active");

    const nonRoot = listedRepository!.worktrees.find((worktree) => worktree.path !== canonicalRepositoryPath);
    expect(nonRoot).toBeDefined();
  });

  it("does not recreate a missing root thread while hydrating repositories", async () => {
    const repositoryPath = createGitRepository();
    const canonicalRepositoryPath = realpathSync(repositoryPath);
    const repositoryService = createRepositoryService(prisma);

    const created = await repositoryService.create({ path: repositoryPath });
    const rootWorktree = created.worktrees.find((worktree) => worktree.path === canonicalRepositoryPath);
    expect(rootWorktree).toBeDefined();

    await prisma.chatThread.deleteMany({
      where: { worktreeId: rootWorktree!.id },
    });

    await repositoryService.list();
    await repositoryService.getById(created.id);

    const threads = await prisma.chatThread.findMany({
      where: { worktreeId: rootWorktree!.id },
      orderBy: { createdAt: "asc" },
    });
    expect(threads).toHaveLength(0);
  });
});
