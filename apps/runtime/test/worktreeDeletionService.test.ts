import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeDeletionService } from "../src/services/worktreeDeletionService";
import { TeardownError } from "../src/services/worktreeService";

function createPrismaMock() {
  return {
    worktree: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
  } as unknown as PrismaClient;
}

function createWorkspaceEventHubMock() {
  return {
    emit: vi.fn(),
  };
}

function createWorktreeServiceMock() {
  return {
    remove: vi.fn(),
  };
}

function createLogServiceMock() {
  return {
    log: vi.fn(),
  };
}

describe("worktreeDeletionService", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("marks a worktree as deleting and removes it in the background", async () => {
    const prisma = createPrismaMock();
    const workspaceEventHub = createWorkspaceEventHubMock();
    const worktreeService = createWorktreeServiceMock();
    const logService = createLogServiceMock();

    prisma.worktree.findUnique.mockResolvedValue({
      id: "wt-1",
      repositoryId: "repo-1",
      path: "/tmp/worktrees/feature",
      status: "active",
      repository: {
        rootPath: "/tmp/repo",
      },
    });
    prisma.worktree.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      repositoryId: "repo-1",
      ...data,
    }));
    worktreeService.remove.mockResolvedValue(undefined);

    const service = createWorktreeDeletionService({
      prisma,
      workspaceEventHub,
      worktreeService,
      logService,
    });

    await service.requestDeletion("wt-1");

    expect(prisma.worktree.update).toHaveBeenCalledWith({
      where: { id: "wt-1" },
      data: {
        status: "deleting",
        lastDeleteError: null,
      },
    });
    expect(workspaceEventHub.emit).toHaveBeenCalledWith("worktree.deletion_started", {
      repositoryId: "repo-1",
      worktreeId: "wt-1",
    });

    await vi.waitFor(() => {
      expect(worktreeService.remove).toHaveBeenCalledWith("wt-1", { force: undefined });
      expect(workspaceEventHub.emit).toHaveBeenCalledWith("worktree.deleted", {
        repositoryId: "repo-1",
        worktreeId: "wt-1",
      });
    });
  });

  it("persists delete_failed state when background deletion fails", async () => {
    const prisma = createPrismaMock();
    const workspaceEventHub = createWorkspaceEventHubMock();
    const worktreeService = createWorktreeServiceMock();
    const logService = createLogServiceMock();

    prisma.worktree.findUnique.mockResolvedValue({
      id: "wt-1",
      repositoryId: "repo-1",
      path: "/tmp/worktrees/feature",
      status: "active",
      repository: {
        rootPath: "/tmp/repo",
      },
    });
    prisma.worktree.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      repositoryId: "repo-1",
      ...data,
    }));
    worktreeService.remove.mockRejectedValue(new TeardownError("teardown failed"));

    const service = createWorktreeDeletionService({
      prisma,
      workspaceEventHub,
      worktreeService,
      logService,
    });

    await service.requestDeletion("wt-1");

    await vi.waitFor(() => {
      expect(prisma.worktree.update).toHaveBeenCalledWith({
        where: { id: "wt-1" },
        data: {
          status: "delete_failed",
          lastDeleteError: "teardown failed",
        },
      });
      expect(workspaceEventHub.emit).toHaveBeenCalledWith("worktree.deletion_failed", {
        repositoryId: "repo-1",
        worktreeId: "wt-1",
      });
    });

    expect(logService.log).toHaveBeenCalledWith(
      "warn",
      "worktree.delete",
      "Background worktree deletion failed",
      {
        worktreeId: "wt-1",
        error: "teardown failed",
        force: false,
      },
      { worktreeId: "wt-1" },
    );
  });

  it("reconciles interrupted deletions on startup", async () => {
    const prisma = createPrismaMock();
    const workspaceEventHub = createWorkspaceEventHubMock();
    const worktreeService = createWorktreeServiceMock();
    const logService = createLogServiceMock();

    prisma.worktree.findMany.mockResolvedValue([
      { id: "wt-1", repositoryId: "repo-1" },
      { id: "wt-2", repositoryId: "repo-2" },
    ]);
    prisma.worktree.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      repositoryId: where.id === "wt-1" ? "repo-1" : "repo-2",
      ...data,
    }));

    const service = createWorktreeDeletionService({
      prisma,
      workspaceEventHub,
      worktreeService,
      logService,
    });

    await expect(service.recoverPendingDeletions()).resolves.toBe(2);

    expect(prisma.worktree.update).toHaveBeenCalledTimes(2);
    expect(workspaceEventHub.emit).toHaveBeenCalledWith("worktree.deletion_failed", {
      repositoryId: "repo-1",
      worktreeId: "wt-1",
    });
    expect(workspaceEventHub.emit).toHaveBeenCalledWith("worktree.deletion_failed", {
      repositoryId: "repo-2",
      worktreeId: "wt-2",
    });
    expect(logService.log).toHaveBeenCalledWith(
      "info",
      "worktree.delete",
      "Recovered interrupted worktree deletions",
      { count: 2 },
    );
  });
});
