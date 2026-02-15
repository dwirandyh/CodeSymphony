import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import { CreateWorktreeInputSchema, type CreateWorktreeInput, type Worktree } from "@codesymphony/shared-types";
import { createGitWorktree, removeGitWorktree } from "./git";
import { mapWorktree } from "./mappers";

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "item";
}

function resolveWorktreeRoot(): string {
  const configured = process.env.WORKTREE_ROOT?.trim();
  if (configured && configured.length > 0) {
    if (configured === "~") {
      return os.homedir();
    }

    if (configured.startsWith("~/")) {
      return path.join(os.homedir(), configured.slice(2));
    }

    return path.resolve(configured);
  }

  return path.join(os.homedir(), ".codesymphony", "worktrees");
}

function buildWorktreePath(repositoryName: string, repositoryId: string, branch: string): string {
  const repositorySegment = `${slugify(repositoryName)}-${repositoryId.slice(0, 8)}`;
  const branchSegment = slugify(branch.replaceAll("/", "-"));
  return path.join(resolveWorktreeRoot(), repositorySegment, branchSegment);
}

export function createWorktreeService(prisma: PrismaClient) {
  return {
    async getById(id: string): Promise<Worktree | null> {
      const worktree = await prisma.worktree.findUnique({ where: { id } });
      return worktree ? mapWorktree(worktree) : null;
    },

    async create(repositoryId: string, rawInput: unknown): Promise<Worktree> {
      const input: CreateWorktreeInput = CreateWorktreeInputSchema.parse(rawInput);

      const repository = await prisma.repository.findUnique({ where: { id: repositoryId } });
      if (!repository) {
        throw new Error("Repository not found");
      }

      const existingByBranch = await prisma.worktree.findFirst({
        where: {
          repositoryId,
          branch: input.branch,
        },
      });

      if (existingByBranch) {
        throw new Error("Branch already has a worktree in this repository");
      }

      const baseBranch = input.baseBranch ?? repository.defaultBranch;
      const worktreePath = buildWorktreePath(repository.name, repository.id, input.branch);

      const existingPath = await stat(worktreePath).catch(() => null);
      if (existingPath) {
        throw new Error(`Worktree path already exists: ${worktreePath}`);
      }

      await mkdir(path.dirname(worktreePath), { recursive: true });

      try {
        await createGitWorktree({
          repositoryPath: repository.rootPath,
          worktreePath,
          branch: input.branch,
          baseBranch,
        });

        const created = await prisma.worktree.create({
          data: {
            repositoryId,
            branch: input.branch,
            path: worktreePath,
            baseBranch,
            status: "active",
          },
        });

        await prisma.chatThread.create({
          data: {
            worktreeId: created.id,
            title: "Main Thread",
          },
        });

        return mapWorktree(created);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new Error("Branch already has a worktree in this repository");
        }
        await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },

    async remove(id: string): Promise<void> {
      const worktree = await prisma.worktree.findUnique({
        where: { id },
        include: { repository: true },
      });

      if (!worktree) {
        throw new Error("Worktree not found");
      }

      await removeGitWorktree({
        repositoryPath: worktree.repository.rootPath,
        worktreePath: worktree.path,
      });

      await prisma.worktree.delete({ where: { id } });
      await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined);
    },

    async listThreads(worktreeId: string) {
      return prisma.chatThread.findMany({
        where: { worktreeId },
        orderBy: { updatedAt: "desc" },
      });
    },
  };
}
