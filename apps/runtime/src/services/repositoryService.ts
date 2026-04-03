import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import prismaClientPkg, { type PrismaClient } from "@prisma/client";
import { CreateRepositoryInputSchema, UpdateRepositoryScriptsInputSchema, type CreateRepositoryInput, type Repository, type UpdateRepositoryScriptsInput } from "@codesymphony/shared-types";
import { ensureGitRepository, detectDefaultBranch, getCurrentBranch, listBranches } from "./git.js";
import { mapRepository } from "./mappers.js";

const { Prisma } = prismaClientPkg as { Prisma: typeof import("@prisma/client").Prisma };

export function normalizeFsPath(inputPath: string): string {
  return path.resolve(inputPath.trim());
}

export function stripPrivatePrefix(input: string): string {
  if (input === "/private") return "/";
  if (input.startsWith("/private/")) return input.slice("/private".length);
  return input;
}

export function areLikelySameFsPath(a: string, b: string): boolean {
  const normalizedA = normalizeFsPath(a);
  const normalizedB = normalizeFsPath(b);
  if (normalizedA === normalizedB) return true;
  if (stripPrivatePrefix(normalizedA) === normalizedB) return true;
  if (normalizedA === stripPrivatePrefix(normalizedB)) return true;
  return false;
}

async function canonicalizeRepositoryPaths(
  repository: {
    id?: string;
    rootPath: string;
    worktrees: Array<{ id?: string; path: string; status?: "active" | "archived" }>;
  },
): Promise<void> {
  const canonicalRootPath = await realpath(repository.rootPath).catch(() => normalizeFsPath(repository.rootPath));
  repository.rootPath = canonicalRootPath;

  await Promise.all(repository.worktrees.map(async (worktree) => {
    worktree.path = await realpath(worktree.path).catch(() => normalizeFsPath(worktree.path));
  }));
}

export function createRepositoryService(prisma: PrismaClient) {
  function resolveUniquePrimaryBranch(
    preferredBranch: string,
    existingBranches: Set<string>,
  ): string {
    if (!existingBranches.has(preferredBranch)) return preferredBranch;
    for (let idx = 1; idx <= 99; idx += 1) {
      const candidate = idx === 1 ? `${preferredBranch}-root` : `${preferredBranch}-root-${idx}`;
      if (!existingBranches.has(candidate)) return candidate;
    }
    return `${preferredBranch}-root-${Date.now()}`;
  }

  async function ensureMainThread(worktreeId: string): Promise<void> {
    const existing = await prisma.chatThread.findFirst({
      where: { worktreeId },
      select: { id: true },
    });
    if (existing) return;
    await prisma.chatThread.create({
      data: {
        worktreeId,
        title: "New Thread",
      },
    });
  }

  async function ensurePrimaryWorktreeExists(
    repository: {
      id: string;
      rootPath: string;
      defaultBranch: string;
      worktrees: Array<{
        id: string;
        branch: string;
        path: string;
        baseBranch: string;
        status: "active" | "archived";
        branchRenamed: boolean;
        createdAt: Date;
        updatedAt: Date;
        repositoryId: string;
      }>;
    },
  ): Promise<void> {
    const rootWorkspace = repository.worktrees.find((worktree) =>
      areLikelySameFsPath(worktree.path, repository.rootPath),
    ) ?? null;

    if (rootWorkspace?.status === "active") {
      await ensureMainThread(rootWorkspace.id);
      return;
    }

    if (rootWorkspace) {
      const reactivated = await prisma.worktree.update({
        where: { id: rootWorkspace.id },
        data: { status: "active" },
      });
      await ensureMainThread(reactivated.id);

      const idx = repository.worktrees.findIndex((worktree) => worktree.id === reactivated.id);
      if (idx >= 0) {
        repository.worktrees[idx] = reactivated;
      } else {
        repository.worktrees.unshift(reactivated);
      }

      console.warn("[repositoryService] reactivated-primary-worktree", {
        repositoryId: repository.id,
        rootPath: repository.rootPath,
        worktreeId: reactivated.id,
      });
      return;
    }

    const existingBranches = new Set(repository.worktrees.map((worktree) => worktree.branch));
    const branchFromRoot = await getCurrentBranch(repository.rootPath);
    const preferredBranch = (branchFromRoot?.trim() || repository.defaultBranch).trim();
    const resolvedBranch = resolveUniquePrimaryBranch(preferredBranch, existingBranches);

    const createdWorktree = await prisma.worktree.create({
      data: {
        repositoryId: repository.id,
        branch: resolvedBranch,
        path: repository.rootPath,
        baseBranch: repository.defaultBranch,
        status: "active",
      },
    });

    await ensureMainThread(createdWorktree.id);
    repository.worktrees.unshift(createdWorktree);
    console.warn("[repositoryService] recovered-missing-primary-worktree", {
      repositoryId: repository.id,
      rootPath: repository.rootPath,
      createdWorktreeId: createdWorktree.id,
      resolvedBranch,
      preferredBranch,
    });
  }

  async function syncWorktreeBranches(
    worktrees: Array<{ id: string; branch: string; path: string; status: "active" | "archived" }>,
  ): Promise<void> {
    const candidates = worktrees.filter((worktree) => worktree.status === "active");

    await Promise.all(candidates.map(async (worktree) => {
      const currentBranch = await getCurrentBranch(worktree.path);
      if (!currentBranch || currentBranch === worktree.branch) return;

      try {
        await prisma.worktree.update({
          where: { id: worktree.id },
          data: { branch: currentBranch },
        });
        worktree.branch = currentBranch;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return;
        }
      }
    }));
  }

  return {
    async list(): Promise<Repository[]> {
      const repositories = await prisma.repository.findMany({
        include: {
          worktrees: {
            orderBy: { updatedAt: "desc" },
          },
        },
        orderBy: { updatedAt: "desc" },
      });

      await Promise.all(repositories.map(async (repository) => {
        await ensurePrimaryWorktreeExists(repository);
        await syncWorktreeBranches(repository.worktrees);
        await canonicalizeRepositoryPaths(repository);
      }));
      return repositories.map(mapRepository);
    },

    async getById(id: string): Promise<Repository | null> {
      const repository = await prisma.repository.findUnique({
        where: { id },
        include: {
          worktrees: {
            orderBy: { updatedAt: "desc" },
          },
        },
      });

      if (repository) {
        await ensurePrimaryWorktreeExists(repository);
        await syncWorktreeBranches(repository.worktrees);
        await canonicalizeRepositoryPaths(repository);
      }
      return repository ? mapRepository(repository) : null;
    },

    async create(rawInput: unknown): Promise<Repository> {
      const input: CreateRepositoryInput = CreateRepositoryInputSchema.parse(rawInput);
      const rootPath = await realpath(normalizeFsPath(input.path)).catch(() => normalizeFsPath(input.path));

      const stats = await stat(rootPath).catch(() => null);
      if (!stats || !stats.isDirectory()) {
        throw new Error("Repository path must point to an existing directory");
      }

      await ensureGitRepository(rootPath);

      const defaultBranch = await detectDefaultBranch(rootPath);
      const name = input.name?.trim() || path.basename(rootPath);

      try {
        const repository = await prisma.$transaction(async (tx) => {
          const createdRepository = await tx.repository.create({
            data: {
              name,
              rootPath,
              defaultBranch,
            },
          });

          const primaryWorktree = await tx.worktree.create({
            data: {
              repositoryId: createdRepository.id,
              branch: defaultBranch,
              path: rootPath,
              baseBranch: defaultBranch,
              status: "active",
            },
          });

          await tx.chatThread.create({
            data: {
              worktreeId: primaryWorktree.id,
              title: "New Thread",
            },
          });

          const hydrated = await tx.repository.findUnique({
            where: { id: createdRepository.id },
            include: {
              worktrees: {
                orderBy: { updatedAt: "desc" },
              },
            },
          });

          if (!hydrated) {
            throw new Error("Repository not found");
          }

          return hydrated;
        });

        await syncWorktreeBranches(repository.worktrees);
        await canonicalizeRepositoryPaths(repository);
        return mapRepository(repository);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new Error("Repository is already added");
        }

        throw error;
      }
    },

    async remove(id: string): Promise<void> {
      const existing = await prisma.repository.findUnique({ where: { id } });
      if (!existing) throw new Error("Repository not found");
      await prisma.repository.delete({ where: { id } });
    },

    async updateScripts(id: string, rawInput: unknown): Promise<Repository> {
      const input: UpdateRepositoryScriptsInput = UpdateRepositoryScriptsInputSchema.parse(rawInput);
      const data: Record<string, string | null> = {};
      if (input.setupScript !== undefined) data.setupScript = input.setupScript ? JSON.stringify(input.setupScript) : null;
      if (input.teardownScript !== undefined) data.teardownScript = input.teardownScript ? JSON.stringify(input.teardownScript) : null;
      if (input.runScript !== undefined) data.runScript = input.runScript ? JSON.stringify(input.runScript) : null;
      if (input.defaultBranch) data.defaultBranch = input.defaultBranch;
      const updated = await prisma.repository.update({ where: { id }, data, include: { worktrees: true } });
      await syncWorktreeBranches(updated.worktrees);
      await canonicalizeRepositoryPaths(updated);
      return mapRepository(updated);
    },

    async listBranches(id: string): Promise<string[]> {
      const repository = await prisma.repository.findUnique({ where: { id } });
      if (!repository) {
        throw new Error("Repository not found");
      }
      return listBranches(repository.rootPath);
    },
  };
}
