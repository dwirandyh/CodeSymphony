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
        title: "Main Thread",
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

    const thread = await prisma.chatThread.findFirst({
      where: {
        worktreeId: listedRepository!.worktrees[0].id,
        title: "Main Thread",
      },
    });
    expect(thread).toBeTruthy();
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
});
