import { stat } from "node:fs/promises";
import path from "node:path";
import prismaClientPkg, { type PrismaClient } from "@prisma/client";
import { CreateRepositoryInputSchema, UpdateRepositoryScriptsInputSchema, type CreateRepositoryInput, type Repository, type UpdateRepositoryScriptsInput } from "@codesymphony/shared-types";
import { ensureGitRepository, detectDefaultBranch, getCurrentBranch, listBranches } from "./git.js";
import { mapRepository } from "./mappers.js";

const { Prisma } = prismaClientPkg as { Prisma: typeof import("@prisma/client").Prisma };

function normalizeFsPath(inputPath: string): string {
  return path.resolve(inputPath.trim());
}

export function createRepositoryService(prisma: PrismaClient) {
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

      await Promise.all(repositories.map((repository) => syncWorktreeBranches(repository.worktrees)));
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
        await syncWorktreeBranches(repository.worktrees);
      }
      return repository ? mapRepository(repository) : null;
    },

    async create(rawInput: unknown): Promise<Repository> {
      const input: CreateRepositoryInput = CreateRepositoryInputSchema.parse(rawInput);
      const rootPath = normalizeFsPath(input.path);

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
              title: "Main Thread",
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
