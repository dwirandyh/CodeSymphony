import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCachedWorktreeGitStatus } from "../src/services/worktreeGitQueryCache";

let repoDir: string | null = null;

function git(args: string) {
  execSync(`git ${args}`, { cwd: repoDir ?? undefined, encoding: "utf8", stdio: "pipe" });
}

async function createRepo() {
  repoDir = await mkdtemp(join(tmpdir(), "cs-git-cache-"));
  git("init --initial-branch=main");
  git('config user.email "test@test.com"');
  git('config user.name "Test"');
  await writeFile(join(repoDir, "tracked.txt"), "one\n");
  git("add tracked.txt");
  git('commit -m "init"');
  return repoDir;
}

afterEach(async () => {
  if (repoDir) {
    await rm(repoDir, { recursive: true, force: true });
    repoDir = null;
  }
});

describe("worktreeGitQueryCache", () => {
  it("bypasses cached git status when refresh is requested", async () => {
    const worktreePath = await createRepo();
    const worktreeId = `wt-${Date.now()}`;

    const cleanStatus = await getCachedWorktreeGitStatus(worktreeId, worktreePath);
    expect(cleanStatus.entries).toEqual([]);

    await writeFile(join(worktreePath, "tracked.txt"), "one\ntwo\n");

    const cachedStatus = await getCachedWorktreeGitStatus(worktreeId, worktreePath);
    expect(cachedStatus.entries).toEqual([]);

    const refreshedStatus = await getCachedWorktreeGitStatus(worktreeId, worktreePath, { refresh: true });
    expect(refreshedStatus.entries).toEqual([
      {
        path: "tracked.txt",
        status: "modified",
        insertions: 1,
        deletions: 0,
      },
    ]);
  });
});
