import type { PrismaClient } from "@prisma/client";
import type { WorkspaceSyncEventHub } from "../types.js";
import { createLogService } from "./logService.js";
import { TeardownError, createWorktreeService } from "./worktreeService.js";

type WorktreeService = ReturnType<typeof createWorktreeService>;
type LogService = ReturnType<typeof createLogService>;

const RESTART_RECOVERY_ERROR = "Deletion was interrupted while the runtime was restarting. Retry the deletion.";

function toDeleteFailureMessage(error: unknown): string {
  if (error instanceof TeardownError) {
    return error.output.trim() || error.message;
  }

  if (error instanceof Error) {
    return error.message.trim() || error.name;
  }

  return String(error);
}

export function createWorktreeDeletionService(args: {
  prisma: PrismaClient;
  workspaceEventHub: WorkspaceSyncEventHub;
  worktreeService: WorktreeService;
  logService: LogService;
}) {
  const {
    prisma,
    workspaceEventHub,
    worktreeService,
    logService,
  } = args;

  const activeJobs = new Map<string, Promise<void>>();

  async function loadDeletionCandidate(worktreeId: string) {
    const worktree = await prisma.worktree.findUnique({
      where: { id: worktreeId },
      include: { repository: true },
    });

    if (!worktree) {
      throw new Error("Worktree not found");
    }

    if (worktree.path === worktree.repository.rootPath) {
      throw new Error("Cannot delete primary worktree");
    }

    return worktree;
  }

  async function markDeletionState(worktreeId: string, status: "deleting" | "delete_failed", lastDeleteError: string | null) {
    return prisma.worktree.update({
      where: { id: worktreeId },
      data: {
        status,
        lastDeleteError,
      },
    });
  }

  async function deleteWorktreeNow(
    worktreeId: string,
    options?: {
      force?: boolean;
      emitWorkspaceEvents?: boolean;
      repositoryId?: string | null;
    },
  ): Promise<void> {
    const existingJob = activeJobs.get(worktreeId);
    if (existingJob) {
      await existingJob;
      return;
    }

    const repositoryId = options?.repositoryId ?? null;

    await worktreeService.remove(worktreeId, { force: options?.force });

    if (options?.emitWorkspaceEvents) {
      workspaceEventHub.emit("worktree.deleted", {
        repositoryId,
        worktreeId,
      });
    }
  }

  function scheduleDeletion(worktreeId: string, options: { force?: boolean; repositoryId: string | null }) {
    const existingJob = activeJobs.get(worktreeId);
    if (existingJob) {
      return existingJob;
    }

    let job: Promise<void>;
    job = (async () => {
      try {
        await deleteWorktreeNow(worktreeId, {
          force: options.force,
          emitWorkspaceEvents: true,
          repositoryId: options.repositoryId,
        });
      } catch (error) {
        const failureMessage = toDeleteFailureMessage(error);

        try {
          const failedWorktree = await markDeletionState(worktreeId, "delete_failed", failureMessage);
          workspaceEventHub.emit("worktree.deletion_failed", {
            repositoryId: failedWorktree.repositoryId,
            worktreeId: failedWorktree.id,
          });
        } catch (updateError) {
          if (!(updateError instanceof Error) || updateError.message !== "Record to update not found.") {
            logService.log("warn", "worktree.delete", "Failed to persist worktree deletion failure state", {
              worktreeId,
              updateError: updateError instanceof Error ? updateError.message : String(updateError),
            }, { worktreeId });
          }
        }

        logService.log("warn", "worktree.delete", "Background worktree deletion failed", {
          worktreeId,
          error: failureMessage,
          force: options.force ?? false,
        }, { worktreeId });
      } finally {
        activeJobs.delete(worktreeId);
      }
    })();

    activeJobs.set(worktreeId, job);
    return job;
  }

  return {
    async requestDeletion(worktreeId: string, options?: { force?: boolean }): Promise<void> {
      const worktree = await loadDeletionCandidate(worktreeId);

      if (worktree.status === "deleting" && activeJobs.has(worktreeId)) {
        return;
      }

      if (worktree.status !== "deleting") {
        await markDeletionState(worktreeId, "deleting", null);
        workspaceEventHub.emit("worktree.deletion_started", {
          repositoryId: worktree.repositoryId,
          worktreeId,
        });
      }

      scheduleDeletion(worktreeId, {
        force: options?.force,
        repositoryId: worktree.repositoryId,
      });
    },

    deleteWorktreeNow,

    async recoverPendingDeletions(): Promise<number> {
      const pendingWorktrees = await prisma.worktree.findMany({
        where: { status: "deleting" },
        select: {
          id: true,
          repositoryId: true,
        },
      });

      await Promise.all(pendingWorktrees.map(async (worktree) => {
        await markDeletionState(worktree.id, "delete_failed", RESTART_RECOVERY_ERROR);
        workspaceEventHub.emit("worktree.deletion_failed", {
          repositoryId: worktree.repositoryId,
          worktreeId: worktree.id,
        });
      }));

      if (pendingWorktrees.length > 0) {
        logService.log("info", "worktree.delete", "Recovered interrupted worktree deletions", {
          count: pendingWorktrees.length,
        });
      }

      return pendingWorktrees.length;
    },
  };
}
