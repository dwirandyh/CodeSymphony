import { execFile as execFileRaw } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceSyncEvent } from "@codesymphony/shared-types";
import { createWorkspaceEventHub } from "../src/events/workspaceEventHub";
import { createWorktreeWatchService } from "../src/services/worktreeWatchService";

const execFile = promisify(execFileRaw);

async function initGitRepository(): Promise<string> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "codesymphony-watch-"));
  await execFile("git", ["init", "-b", "main"], { cwd: rootPath });
  await execFile("git", ["config", "user.name", "CodeSymphony Test"], { cwd: rootPath });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: rootPath });
  return rootPath;
}

async function waitForEventCount(events: WorkspaceSyncEvent[], expectedCount: number): Promise<void> {
  const timeoutAt = Date.now() + 5_000;
  while (events.length < expectedCount && Date.now() < timeoutAt) {
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  expect(events.length).toBeGreaterThanOrEqual(expectedCount);
}

describe("worktreeWatchService", () => {
  const cleanupPaths = new Set<string>();

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.allSettled(
      [...cleanupPaths].map(async (targetPath) => {
        await rm(targetPath, { recursive: true, force: true });
      }),
    );
    cleanupPaths.clear();
  });

  it("emits file and git workspace events when a worktree file changes externally", async () => {
    const worktreePath = await initGitRepository();
    cleanupPaths.add(worktreePath);
    await mkdir(path.join(worktreePath, "src"), { recursive: true });

    const events: WorkspaceSyncEvent[] = [];
    const workspaceEventHub = createWorkspaceEventHub();
    const unsubscribe = workspaceEventHub.subscribe((event) => {
      events.push(event);
    });

    const invalidatedFileCaches: string[] = [];
    const invalidatedGitCaches: string[] = [];
    const watchService = createWorktreeWatchService({
      workspaceEventHub,
      listWorktrees: async () => [{
        id: "wt-1",
        repositoryId: "repo-1",
        path: worktreePath,
        status: "active",
      }],
      onFilesChanged(worktree) {
        invalidatedFileCaches.push(worktree.id);
      },
      onGitChanged(worktree) {
        invalidatedGitCaches.push(worktree.id);
      },
      debounceMs: 40,
      rescanIntervalMs: 10_000,
    });

    watchService.start();
    await watchService.refresh();

    await writeFile(path.join(worktreePath, "src", "feature.ts"), "export const value = 1;\n", "utf8");

    await waitForEventCount(events, 2);

    watchService.dispose();
    unsubscribe();

    expect(events.map((event) => event.type)).toEqual([
      "worktree.files.updated",
      "worktree.git.updated",
    ]);
    expect(events.every((event) => event.worktreeId === "wt-1")).toBe(true);
    expect(events.every((event) => event.repositoryId === "repo-1")).toBe(true);
    expect(invalidatedFileCaches).toEqual(["wt-1"]);
    expect(invalidatedGitCaches).toEqual(["wt-1"]);
  });

  it("emits only a git workspace event when git metadata changes externally", async () => {
    const worktreePath = await initGitRepository();
    cleanupPaths.add(worktreePath);

    const events: WorkspaceSyncEvent[] = [];
    const workspaceEventHub = createWorkspaceEventHub();
    const unsubscribe = workspaceEventHub.subscribe((event) => {
      events.push(event);
    });

    const invalidatedFileCaches: string[] = [];
    const invalidatedGitCaches: string[] = [];
    const watchService = createWorktreeWatchService({
      workspaceEventHub,
      listWorktrees: async () => [{
        id: "wt-1",
        repositoryId: "repo-1",
        path: worktreePath,
        status: "active",
      }],
      onFilesChanged(worktree) {
        invalidatedFileCaches.push(worktree.id);
      },
      onGitChanged(worktree) {
        invalidatedGitCaches.push(worktree.id);
      },
      debounceMs: 40,
      rescanIntervalMs: 10_000,
    });

    watchService.start();
    await watchService.refresh();

    await writeFile(path.join(worktreePath, ".git", "FETCH_HEAD"), "origin/main\n", "utf8");

    await waitForEventCount(events, 1);

    watchService.dispose();
    unsubscribe();

    expect(events.map((event) => event.type)).toEqual(["worktree.git.updated"]);
    expect(invalidatedFileCaches).toEqual([]);
    expect(invalidatedGitCaches).toEqual(["wt-1"]);
  });
});
