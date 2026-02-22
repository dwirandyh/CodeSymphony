import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import { CreateWorktreeInputSchema, type CreateWorktreeInput, type ScriptResult, type Worktree } from "@codesymphony/shared-types";
import { createGitWorktree, removeGitWorktree, renameBranch as renameBranchGit } from "./git";
import { mapWorktree } from "./mappers";
import { runScripts } from "./scriptRunner";

export interface CreateWorktreeResult {
  worktree: Worktree;
  scriptResult?: ScriptResult;
}

export class TeardownError extends Error {
  public readonly output: string;
  constructor(output: string) {
    super("Teardown scripts failed");
    this.name = "TeardownError";
    this.output = output;
  }
}

const INDONESIAN_PROVINCES = [
  "Aceh",
  "North Sumatra",
  "West Sumatra",
  "Riau",
  "Riau Islands",
  "Jambi",
  "South Sumatra",
  "Bengkulu",
  "Lampung",
  "Bangka Belitung Islands",
  "Jakarta",
  "West Java",
  "Central Java",
  "East Java",
  "Banten",
  "Yogyakarta",
  "Bali",
  "West Nusa Tenggara",
  "East Nusa Tenggara",
  "West Kalimantan",
  "Central Kalimantan",
  "South Kalimantan",
  "East Kalimantan",
  "North Kalimantan",
  "North Sulawesi",
  "Gorontalo",
  "Central Sulawesi",
  "West Sulawesi",
  "South Sulawesi",
  "Southeast Sulawesi",
  "Maluku",
  "North Maluku",
  "West Papua",
  "Southwest Papua",
  "Central Papua",
  "Highland Papua",
  "South Papua",
  "Papua",
] as const;

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

function buildProvinceBranchName(attempt: number): string {
  const provinceIndex = attempt % INDONESIAN_PROVINCES.length;
  const cycle = Math.floor(attempt / INDONESIAN_PROVINCES.length);
  const provinceSlug = slugify(INDONESIAN_PROVINCES[provinceIndex]);
  return cycle === 0 ? provinceSlug : `${provinceSlug}-${cycle + 1}`;
}

function isBranchAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("already exists");
}

const PROVINCE_SLUGS = new Set(INDONESIAN_PROVINCES.map((name) => slugify(name)));

export function isDefaultBranchName(branch: string): boolean {
  const match = /^(.+?)(?:-(\d+))?$/.exec(branch);
  if (!match) return false;
  return PROVINCE_SLUGS.has(match[1]);
}

export function createWorktreeService(prisma: PrismaClient) {
  return {
    async getById(id: string): Promise<Worktree | null> {
      const worktree = await prisma.worktree.findUnique({ where: { id } });
      return worktree ? mapWorktree(worktree) : null;
    },

    async create(repositoryId: string, rawInput: unknown): Promise<CreateWorktreeResult> {
      const input: CreateWorktreeInput = CreateWorktreeInputSchema.parse(rawInput ?? {});

      const repository = await prisma.repository.findUnique({ where: { id: repositoryId } });
      if (!repository) {
        throw new Error("Repository not found");
      }

      const existingWorktrees = await prisma.worktree.findMany({
        where: { repositoryId },
        select: { branch: true },
      });
      const existingBranches = new Set(existingWorktrees.map((worktree) => worktree.branch));

      const requestedBranch = input.branch?.trim() || null;
      const isAutomaticBranch = requestedBranch === null;
      const baseBranch = input.baseBranch ?? (isAutomaticBranch ? "main" : repository.defaultBranch);

      if (requestedBranch && existingBranches.has(requestedBranch)) {
        throw new Error("Branch already has a worktree in this repository");
      }

      const maxAttempts = INDONESIAN_PROVINCES.length * 30;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const branch = requestedBranch ?? buildProvinceBranchName(attempt);

        if (existingBranches.has(branch)) {
          if (requestedBranch) {
            throw new Error("Branch already has a worktree in this repository");
          }
          continue;
        }

        const worktreePath = buildWorktreePath(repository.name, repository.id, branch);
        const existingPath = await stat(worktreePath).catch(() => null);
        if (existingPath) {
          if (requestedBranch) {
            throw new Error(`Worktree path already exists: ${worktreePath}`);
          }
          existingBranches.add(branch);
          continue;
        }

        await mkdir(path.dirname(worktreePath), { recursive: true });

        try {
          await createGitWorktree({
            repositoryPath: repository.rootPath,
            worktreePath,
            branch,
            baseBranch,
          });

          const created = await prisma.worktree.create({
            data: {
              repositoryId,
              branch,
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

          return { worktree: mapWorktree(created) };
        } catch (error) {
          await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);

          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            if (requestedBranch) {
              throw new Error("Branch already has a worktree in this repository");
            }
            existingBranches.add(branch);
            continue;
          }

          if (!requestedBranch && isBranchAlreadyExistsError(error)) {
            existingBranches.add(branch);
            continue;
          }

          throw error;
        }
      }

      if (requestedBranch) {
        throw new Error("Unable to create worktree");
      }

      throw new Error("Unable to allocate an automatic worktree name. Try deleting unused worktrees first.");
    },

    async remove(id: string, options?: { force?: boolean }): Promise<void> {
      const worktree = await prisma.worktree.findUnique({
        where: { id },
        include: { repository: true },
      });

      if (!worktree) {
        throw new Error("Worktree not found");
      }

      // Run teardown scripts if configured (skip if force-deleting)
      if (!options?.force && worktree.repository.teardownScript) {
        try {
          const commands: string[] = JSON.parse(worktree.repository.teardownScript);
          if (commands.length > 0) {
            const env = {
              CODESYMPHONY_ROOT_PATH: worktree.repository.rootPath,
              CODESYMPHONY_WORKTREE_NAME: worktree.branch,
            };
            const result = await runScripts(commands, worktree.path, env);
            if (!result.success) {
              throw new TeardownError(result.output);
            }
          }
        } catch (e) {
          if (e instanceof TeardownError) {
            throw e;
          }
          console.warn(`Failed to parse/run teardown scripts: ${e}`);
        }
      }

      await removeGitWorktree({
        repositoryPath: worktree.repository.rootPath,
        worktreePath: worktree.path,
      });

      await prisma.worktree.delete({ where: { id } });
      await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined);
    },

    async renameBranch(
      worktreeId: string,
      newBranch: string,
      options?: { isManualRename?: boolean },
    ): Promise<Worktree> {
      const worktree = await prisma.worktree.findUnique({
        where: { id: worktreeId },
      });

      if (!worktree) {
        throw new Error("Worktree not found");
      }

      if (worktree.branch === newBranch) {
        return mapWorktree(worktree);
      }

      const existing = await prisma.worktree.findFirst({
        where: {
          repositoryId: worktree.repositoryId,
          branch: newBranch,
          id: { not: worktreeId },
        },
      });
      if (existing) {
        throw new Error("A worktree with this branch name already exists in this repository");
      }

      await renameBranchGit({
        cwd: worktree.path,
        oldBranch: worktree.branch,
        newBranch,
      });

      const updated = await prisma.worktree.update({
        where: { id: worktreeId },
        data: {
          branch: newBranch,
          branchRenamed: options?.isManualRename ?? true,
        },
      });

      return mapWorktree(updated);
    },

    async rerunSetup(worktreeId: string): Promise<ScriptResult> {
      const worktree = await prisma.worktree.findUnique({
        where: { id: worktreeId },
        include: { repository: true },
      });

      if (!worktree) {
        throw new Error("Worktree not found");
      }

      if (!worktree.repository.setupScript) {
        return { success: true, output: "No setup scripts configured." };
      }

      try {
        const commands: string[] = JSON.parse(worktree.repository.setupScript);
        if (commands.length === 0) {
          return { success: true, output: "No setup scripts configured." };
        }

        const env = {
          CODESYMPHONY_ROOT_PATH: worktree.repository.rootPath,
          CODESYMPHONY_WORKTREE_NAME: worktree.branch,
        };
        return await runScripts(commands, worktree.path, env);
      } catch (e) {
        return { success: false, output: e instanceof Error ? e.message : String(e) };
      }
    },

    async getSetupContext(worktreeId: string): Promise<{
      commands: string[];
      cwd: string;
      env: Record<string, string>;
    } | null> {
      const worktree = await prisma.worktree.findUnique({
        where: { id: worktreeId },
        include: { repository: true },
      });

      if (!worktree) return null;
      if (!worktree.repository.setupScript) return null;

      try {
        const commands: string[] = JSON.parse(worktree.repository.setupScript);
        if (commands.length === 0) return null;

        return {
          commands,
          cwd: worktree.path,
          env: {
            CODESYMPHONY_ROOT_PATH: worktree.repository.rootPath,
            CODESYMPHONY_WORKTREE_NAME: worktree.branch,
          },
        };
      } catch {
        return null;
      }
    },

    async getRunScriptContext(worktreeId: string): Promise<{
      commands: string[];
      cwd: string;
      env: Record<string, string>;
    } | null> {
      const worktree = await prisma.worktree.findUnique({
        where: { id: worktreeId },
        include: { repository: true },
      });

      if (!worktree) return null;
      if (!worktree.repository.runScript) return null;

      try {
        const commands: string[] = JSON.parse(worktree.repository.runScript);
        if (commands.length === 0) return null;

        return {
          commands,
          cwd: worktree.path,
          env: {
            CODESYMPHONY_ROOT_PATH: worktree.repository.rootPath,
            CODESYMPHONY_WORKTREE_NAME: worktree.branch,
          },
        };
      } catch {
        return null;
      }
    },

    async listThreads(worktreeId: string) {
      return prisma.chatThread.findMany({
        where: { worktreeId },
        orderBy: { updatedAt: "desc" },
      });
    },
  };
}
