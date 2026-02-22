import { stat } from "node:fs/promises";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import { CreateRepositoryInputSchema, UpdateRepositoryScriptsInputSchema, type CreateRepositoryInput, type Repository, type UpdateRepositoryScriptsInput } from "@codesymphony/shared-types";
import { ensureGitRepository, detectDefaultBranch } from "./git";
import { mapRepository } from "./mappers";

function normalizeFsPath(inputPath: string): string {
  return path.resolve(inputPath.trim());
}

export function createRepositoryService(prisma: PrismaClient) {
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
        const repository = await prisma.repository.create({
          data: {
            name,
            rootPath,
            defaultBranch,
          },
          include: {
            worktrees: true,
          },
        });

        return mapRepository(repository);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new Error("Repository is already added");
        }

        throw error;
      }
    },

    async updateScripts(id: string, rawInput: unknown): Promise<Repository> {
      const input: UpdateRepositoryScriptsInput = UpdateRepositoryScriptsInputSchema.parse(rawInput);
      const data: Record<string, string | null> = {};
      if (input.setupScript !== undefined) data.setupScript = input.setupScript ? JSON.stringify(input.setupScript) : null;
      if (input.teardownScript !== undefined) data.teardownScript = input.teardownScript ? JSON.stringify(input.teardownScript) : null;
      const updated = await prisma.repository.update({ where: { id }, data, include: { worktrees: true } });
      return mapRepository(updated);
    },
  };
}
