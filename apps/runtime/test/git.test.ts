import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureGitRepository,
  detectDefaultBranch,
  listBranches,
  getCurrentBranch,
  getGitStatus,
  getGitBranchDiffSummary,
  getGitDiff,
  getFileAtHead,
  gitCommitAll,
  discardGitChange,
  detectReviewProvider,
  syncCurrentBranch,
  rebaseWorktreeOntoBaseBranch,
} from "../src/services/git";

let repoDir: string;

function git(args: string) {
  execSync(`git ${args}`, { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
}

function gitIn(cwd: string, args: string) {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: "pipe" });
}

async function createRepoWithRemote() {
  const localRepo = await mkdtemp(join(tmpdir(), "cs-git-local-"));
  const remoteRepo = await mkdtemp(join(tmpdir(), "cs-git-remote-"));

  gitIn(localRepo, "init --initial-branch=main");
  gitIn(localRepo, 'config user.email "test@test.com"');
  gitIn(localRepo, 'config user.name "Test"');
  await writeFile(join(localRepo, "README.md"), "# Hello");
  gitIn(localRepo, "add -A");
  gitIn(localRepo, 'commit -m "init"');

  gitIn(remoteRepo, "init --bare --initial-branch=main");
  gitIn(localRepo, `remote add origin "${remoteRepo}"`);
  gitIn(localRepo, "push -u origin HEAD:main");

  return { localRepo, remoteRepo };
}

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "cs-git-test-"));
  git("init --initial-branch=main");
  git('config user.email "test@test.com"');
  git('config user.name "Test"');
  await writeFile(join(repoDir, "README.md"), "# Hello");
  git("add -A");
  git('commit -m "init"');
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("git utilities", () => {
  describe("ensureGitRepository", () => {
    it("succeeds for valid git repo", async () => {
      await expect(ensureGitRepository(repoDir)).resolves.toBeUndefined();
    });

    it("throws for non-git directory", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "cs-nogit-"));
      await expect(ensureGitRepository(tmpDir)).rejects.toThrow();
      await rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe("detectDefaultBranch", () => {
    it("returns current branch name", async () => {
      const branch = await detectDefaultBranch(repoDir);
      expect(branch).toBe("main");
    });
  });

  describe("listBranches", () => {
    it("returns branch list", async () => {
      const branches = await listBranches(repoDir);
      expect(branches).toContain("main");
    });
  });

  describe("getCurrentBranch", () => {
    it("returns current branch", async () => {
      const branch = await getCurrentBranch(repoDir);
      expect(branch).toBe("main");
    });

    it("returns null for invalid directory", async () => {
      const branch = await getCurrentBranch("/nonexistent-dir-12345");
      expect(branch).toBeNull();
    });
  });

  describe("getGitStatus", () => {
    it("returns empty entries for clean repo", async () => {
      const status = await getGitStatus(repoDir);
      expect(status.branch).toBe("main");
      expect(status.entries).toEqual([]);
    });

    it("detects modified files", async () => {
      await writeFile(join(repoDir, "README.md"), "# Modified");
      const status = await getGitStatus(repoDir);
      expect(status.entries.length).toBeGreaterThan(0);
      expect(status.entries[0].status).toBe("modified");
      git("checkout -- README.md");
    });

    it("detects untracked text file insertions", async () => {
      await writeFile(join(repoDir, "untracked.txt"), "one\ntwo\nthree\n");
      const status = await getGitStatus(repoDir);
      const untracked = status.entries.find((e) => e.path === "untracked.txt");
      expect(untracked).toBeTruthy();
      expect(untracked!.status).toBe("untracked");
      expect(untracked!.insertions).toBe(3);
      expect(untracked!.deletions).toBe(0);
      git("clean -f untracked.txt");
    });

    it("detects untracked files inside a new directory individually", async () => {
      const nestedDir = join(repoDir, "src/generated");
      await mkdir(nestedDir, { recursive: true });
      await writeFile(join(nestedDir, "nested.ts"), "export const nested = true;\n");

      const status = await getGitStatus(repoDir);
      const untracked = status.entries.find((entry) => entry.path === "src/generated/nested.ts");
      expect(untracked).toBeTruthy();
      expect(untracked?.status).toBe("untracked");
      expect(untracked?.insertions).toBe(1);
      expect(untracked?.deletions).toBe(0);
      git("clean -fd src");
    });

    it("reports zero insertions for empty untracked files", async () => {
      await writeFile(join(repoDir, "empty.txt"), "");

      const status = await getGitStatus(repoDir);
      const untracked = status.entries.find((entry) => entry.path === "empty.txt");
      expect(untracked).toBeTruthy();
      expect(untracked?.status).toBe("untracked");
      expect(untracked?.insertions).toBe(0);
      expect(untracked?.deletions).toBe(0);
      git("clean -f empty.txt");
    });

    it("reports zero insertions for binary-like untracked files", async () => {
      await writeFile(join(repoDir, "binary.bin"), Buffer.from([0x61, 0x00, 0x62, 0x0a]));

      const status = await getGitStatus(repoDir);
      const untracked = status.entries.find((entry) => entry.path === "binary.bin");
      expect(untracked).toBeTruthy();
      expect(untracked?.status).toBe("untracked");
      expect(untracked?.insertions).toBe(0);
      expect(untracked?.deletions).toBe(0);
      git("clean -f binary.bin");
    });

    it("reports zero insertions for untracked PNG files", async () => {
      await writeFile(join(repoDir, "screenshot.png"), Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d,
      ]));

      const status = await getGitStatus(repoDir);
      const untracked = status.entries.find((entry) => entry.path === "screenshot.png");
      expect(untracked).toBeTruthy();
      expect(untracked?.status).toBe("untracked");
      expect(untracked?.insertions).toBe(0);
      expect(untracked?.deletions).toBe(0);
      git("clean -f screenshot.png");
    });

    it("reports upstream sync state", async () => {
      const { localRepo, remoteRepo } = await createRepoWithRemote();
      const peerRepo = await mkdtemp(join(tmpdir(), "cs-git-peer-"));

      try {
        let status = await getGitStatus(localRepo);
        expect(status.upstream).toBe("origin/main");
        expect(status.ahead).toBe(0);
        expect(status.behind).toBe(0);

        await writeFile(join(localRepo, "local.txt"), "local\n");
        gitIn(localRepo, "add local.txt");
        gitIn(localRepo, 'commit -m "local change"');

        status = await getGitStatus(localRepo);
        expect(status.ahead).toBe(1);
        expect(status.behind).toBe(0);

        gitIn(peerRepo, `clone "${remoteRepo}" .`);
        gitIn(peerRepo, 'config user.email "test@test.com"');
        gitIn(peerRepo, 'config user.name "Test"');
        await writeFile(join(peerRepo, "remote.txt"), "remote\n");
        gitIn(peerRepo, "add remote.txt");
        gitIn(peerRepo, 'commit -m "remote change"');
        gitIn(peerRepo, "push origin main");

        gitIn(localRepo, "fetch origin");
        status = await getGitStatus(localRepo);
        expect(status.upstream).toBe("origin/main");
        expect(status.ahead).toBe(1);
        expect(status.behind).toBe(1);
      } finally {
        await rm(peerRepo, { recursive: true, force: true });
        await rm(localRepo, { recursive: true, force: true });
        await rm(remoteRepo, { recursive: true, force: true });
      }
    });

    it("throws when the worktree path does not exist instead of fabricating HEAD", async () => {
      await expect(getGitStatus("/nonexistent-dir-12345")).rejects.toThrow(
        "Worktree path not found: /nonexistent-dir-12345. Create a new worktree from Repository panel.",
      );
    });
  });

  describe("getGitBranchDiffSummary", () => {
    it("returns zero summary when branch matches base branch", async () => {
      const summary = await getGitBranchDiffSummary(repoDir, "main");
      expect(summary).toMatchObject({
        branch: "main",
        baseBranch: "main",
        insertions: 0,
        deletions: 0,
        filesChanged: 0,
        available: true,
      });
    });

    it("returns committed branch diff summary and ignores uncommitted changes", async () => {
      git("checkout -b feature-branch");
      await writeFile(join(repoDir, "feature.txt"), "one\ntwo\nthree\n");
      git("add feature.txt");
      git('commit -m "feature change"');
      await writeFile(join(repoDir, "README.md"), "# Uncommitted change");

      const summary = await getGitBranchDiffSummary(repoDir, "main");
      expect(summary.branch).toBe("feature-branch");
      expect(summary.baseBranch).toBe("main");
      expect(summary.insertions).toBe(3);
      expect(summary.deletions).toBe(0);
      expect(summary.filesChanged).toBe(1);
      expect(summary.available).toBe(true);

      git("checkout -- README.md");
      git("checkout main");
      git("branch -D feature-branch");
    });

    it("returns unavailable summary when base branch is missing", async () => {
      const summary = await getGitBranchDiffSummary(repoDir, "missing-base");
      expect(summary.available).toBe(false);
      expect(summary.unavailableReason).toContain("missing-base");
      expect(summary.ahead).toBe(0);
      expect(summary.behind).toBe(0);
    });

    it("reports behind count when base has commits the branch lacks", async () => {
      git("checkout -b behind-feat");
      git("checkout main");
      await writeFile(join(repoDir, "base-advance.txt"), "x\n");
      git("add -A");
      git('commit -m "base advance"');
      git("checkout behind-feat");

      const summary = await getGitBranchDiffSummary(repoDir, "main");
      expect(summary.behind).toBe(1);
      expect(summary.ahead).toBe(0);
      expect(summary.available).toBe(true);

      git("checkout main");
      git("reset --hard HEAD~1");
      git("branch -D behind-feat");
    });

    it("reports ahead count when branch has commits base lacks", async () => {
      git("checkout -b ahead-feat");
      await writeFile(join(repoDir, "feat-change.txt"), "y\n");
      git("add -A");
      git('commit -m "feat change"');

      const summary = await getGitBranchDiffSummary(repoDir, "main");
      expect(summary.ahead).toBe(1);
      expect(summary.behind).toBe(0);
      expect(summary.available).toBe(true);

      git("checkout main");
      git("branch -D ahead-feat");
    });

    it("uses branchFallback when HEAD is detached", async () => {
      git("checkout -b detached-feat");
      await writeFile(join(repoDir, "detached-change.txt"), "feature\n");
      git("add detached-change.txt");
      git('commit -m "detached feature"');
      const tip = execSync("git rev-parse detached-feat", { cwd: repoDir, encoding: "utf8" }).trim();
      git(`checkout ${tip}`);

      const summary = await getGitBranchDiffSummary(repoDir, "main", { branchFallback: "detached-feat" });
      expect(summary.branch).toBe("detached-feat");
      expect(summary.insertions).toBeGreaterThan(0);
      expect(summary.filesChanged).toBeGreaterThan(0);
      expect(summary.ahead).toBe(1);

      git("checkout main");
      git("branch -D detached-feat");
    });

    it("returns zero summary for a branch created at origin base when local base is stale", async () => {
      const { localRepo, remoteRepo } = await createRepoWithRemote();
      try {
        gitIn(localRepo, "checkout -b dev");
        await writeFile(join(localRepo, "dev-only.txt"), "local dev\n");
        gitIn(localRepo, "add dev-only.txt");
        gitIn(localRepo, 'commit -m "local dev advance"');

        gitIn(localRepo, "checkout main");
        await writeFile(join(localRepo, "origin-only.txt"), "origin dev\n");
        gitIn(localRepo, "add origin-only.txt");
        gitIn(localRepo, 'commit -m "origin dev advance"');
        gitIn(localRepo, "push origin HEAD:dev");

        gitIn(localRepo, "fetch origin dev");
        gitIn(localRepo, "branch -f fresh-worktree origin/dev");
        gitIn(localRepo, "checkout fresh-worktree");

        const summary = await getGitBranchDiffSummary(localRepo, "dev");
        expect(summary).toMatchObject({
          branch: "fresh-worktree",
          baseBranch: "dev",
          insertions: 0,
          deletions: 0,
          filesChanged: 0,
          available: true,
          ahead: 0,
          behind: 0,
        });
      } finally {
        await rm(localRepo, { recursive: true, force: true });
        await rm(remoteRepo, { recursive: true, force: true });
      }
    });

    it("uses rebasing branch ref when HEAD is detached during rebase", async () => {
      git("checkout -b rebase-feat");
      await writeFile(join(repoDir, "shared.txt"), "feature\n");
      git("add shared.txt");
      git('commit -m "feature change"');
      git("checkout main");
      await writeFile(join(repoDir, "shared.txt"), "main\n");
      git("add shared.txt");
      git('commit -m "base advance"');
      git("checkout rebase-feat");

      try {
        git("rebase main");
      } catch {
        // Rebase stops on the conflict with a detached HEAD.
      }

      const summary = await getGitBranchDiffSummary(repoDir, "main");
      expect(summary.branch).toBe("rebase-feat");
      expect(summary.insertions).toBeGreaterThan(0);
      expect(summary.filesChanged).toBeGreaterThan(0);

      try {
        git("rebase --abort");
      } catch {
        // Fall through to checkout main below.
      }
      git("checkout main");
      git("branch -D rebase-feat");
    });
  });

  describe("rebaseWorktreeOntoBaseBranch", () => {
    it("replays branch commits onto the fetched base branch", async () => {
      const { localRepo, remoteRepo } = await createRepoWithRemote();
      try {
        gitIn(localRepo, "checkout -b feature");
        await writeFile(join(localRepo, "feature.txt"), "feature\n");
        gitIn(localRepo, "add feature.txt");
        gitIn(localRepo, 'commit -m "feature change"');

        gitIn(localRepo, "checkout main");
        await writeFile(join(localRepo, "base-new.txt"), "base\n");
        gitIn(localRepo, "add base-new.txt");
        gitIn(localRepo, 'commit -m "base advance"');
        gitIn(localRepo, "push origin main");
        gitIn(localRepo, "checkout feature");

        const result = await rebaseWorktreeOntoBaseBranch(localRepo, "main");
        expect(result.behind).toBe(0);
        expect(result.ahead).toBe(1);
        expect(result.baseBranch).toBe("main");

        // After rebase, the feature commit sits on top of the advanced base:
        // base advance must be reachable from HEAD (no longer behind).
        const gitLog = gitIn(localRepo, "rev-list --count HEAD..origin/main");
        expect(Number.parseInt(gitLog.trim(), 10)).toBe(0);
      } finally {
        await rm(localRepo, { recursive: true, force: true });
        await rm(remoteRepo, { recursive: true, force: true });
      }
    });

    it("throws when a rebase is already in progress", async () => {
      git("checkout -b rebase-blocked");
      await writeFile(join(repoDir, "blocked.txt"), "feature\n");
      git("add blocked.txt");
      git('commit -m "feature change"');
      git("checkout main");
      await writeFile(join(repoDir, "blocked.txt"), "main\n");
      git("add blocked.txt");
      git('commit -m "base advance"');
      git("checkout rebase-blocked");

      try {
        git("rebase main");
      } catch {
        // Rebase stops on the conflict with a detached HEAD.
      }

      await expect(rebaseWorktreeOntoBaseBranch(repoDir, "main")).rejects.toThrow(
        "A rebase is already in progress",
      );

      try {
        git("rebase --abort");
      } catch {
        // Fall through to checkout main below.
      }
      git("checkout main");
      git("branch -D rebase-blocked");
    });

    it("throws when the base branch is unavailable", async () => {
      const tmpRepo = await mkdtemp(join(tmpdir(), "cs-git-rebase-none-"));
      try {
        gitIn(tmpRepo, "init --initial-branch=main");
        gitIn(tmpRepo, 'config user.email "test@test.com"');
        gitIn(tmpRepo, 'config user.name "Test"');
        await writeFile(join(tmpRepo, "README.md"), "# Hello");
        gitIn(tmpRepo, "add -A");
        gitIn(tmpRepo, 'commit -m "init"');
        gitIn(tmpRepo, "checkout -b feature");

        await expect(rebaseWorktreeOntoBaseBranch(tmpRepo, "nonexistent")).rejects.toThrow();
      } finally {
        await rm(tmpRepo, { recursive: true, force: true });
      }
    });
  });

  describe("getGitDiff", () => {
    it("returns empty for clean repo", async () => {
      const diff = await getGitDiff(repoDir);
      expect(diff).toBe("");
    });

    it("returns diff for modified files", async () => {
      await writeFile(join(repoDir, "README.md"), "# Changed");
      const diff = await getGitDiff(repoDir);
      expect(diff).toContain("Changed");
      git("checkout -- README.md");
    });

    it("returns diff for specific file", async () => {
      await writeFile(join(repoDir, "README.md"), "# Specific");
      const diff = await getGitDiff(repoDir, "README.md");
      expect(diff).toContain("Specific");
      git("checkout -- README.md");
    });

    it("returns diff for selected untracked file", async () => {
      await writeFile(join(repoDir, "untracked.txt"), "brand new file\n");
      const diff = await getGitDiff(repoDir, "untracked.txt");
      expect(diff).toContain("diff --git");
      expect(diff).toContain("--- /dev/null");
      expect(diff).toContain("+++ b/untracked.txt");
      expect(diff).toContain("brand new file");
      git("clean -f untracked.txt");
    });

    it("includes untracked files in full diff review", async () => {
      await writeFile(join(repoDir, "untracked.txt"), "brand new file\n");
      const diff = await getGitDiff(repoDir);
      expect(diff).toContain("+++ b/untracked.txt");
      expect(diff).toContain("brand new file");
      git("clean -f untracked.txt");
    });
  });

  describe("getFileAtHead", () => {
    it("returns file content at HEAD", async () => {
      const content = await getFileAtHead(repoDir, "README.md");
      expect(content).toBe("# Hello");
    });

    it("preserves trailing newlines in HEAD content", async () => {
      await writeFile(join(repoDir, "newline.txt"), "alpha\nbeta\n");
      git("add newline.txt");
      git("commit -m \"Add newline fixture\"");

      const content = await getFileAtHead(repoDir, "newline.txt");
      expect(content).toBe("alpha\nbeta\n");
    });

    it("returns null for non-existent file", async () => {
      const content = await getFileAtHead(repoDir, "nonexistent.txt");
      expect(content).toBeNull();
    });
  });

  describe("gitCommitAll", () => {
    it("commits all changes", async () => {
      await writeFile(join(repoDir, "new-file.txt"), "content");
      const result = await gitCommitAll(repoDir, "Add new file");
      expect(result).toContain("Add new file");
      const status = await getGitStatus(repoDir);
      expect(status.entries.find(e => e.path === "new-file.txt")).toBeUndefined();
    });

    it("retries when a transient index lock is present", async () => {
      await writeFile(join(repoDir, "locked-file.txt"), "content");
      const lockPath = join(repoDir, ".git", "index.lock");
      await writeFile(lockPath, "");

      const releaseLock = setTimeout(() => {
        void unlink(lockPath).catch(() => undefined);
      }, 150);

      try {
        const result = await gitCommitAll(repoDir, "Add locked file");
        expect(result).toContain("Add locked file");
        const status = await getGitStatus(repoDir);
        expect(status.entries.find(e => e.path === "locked-file.txt")).toBeUndefined();
      } finally {
        clearTimeout(releaseLock);
        await unlink(lockPath).catch(() => undefined);
      }
    });
  });

  describe("discardGitChange", () => {
    it("discards modifications to tracked file", async () => {
      await writeFile(join(repoDir, "README.md"), "# Discard me");
      await discardGitChange(repoDir, "README.md");
      const content = await getFileAtHead(repoDir, "README.md");
      expect(content).toBe("# Hello");
    });

    it("removes untracked file", async () => {
      await writeFile(join(repoDir, "temp.txt"), "remove me");
      await discardGitChange(repoDir, "temp.txt");
      const status = await getGitStatus(repoDir);
      expect(status.entries.find(e => e.path === "temp.txt")).toBeUndefined();
    });
  });

  describe("syncCurrentBranch", () => {
    it("pulls and pushes the tracked branch until it matches upstream", async () => {
      const { localRepo, remoteRepo } = await createRepoWithRemote();
      const peerRepo = await mkdtemp(join(tmpdir(), "cs-git-sync-peer-"));

      try {
        await writeFile(join(localRepo, "local.txt"), "local\n");
        gitIn(localRepo, "add local.txt");
        gitIn(localRepo, 'commit -m "local change"');

        gitIn(peerRepo, `clone "${remoteRepo}" .`);
        gitIn(peerRepo, 'config user.email "test@test.com"');
        gitIn(peerRepo, 'config user.name "Test"');
        await writeFile(join(peerRepo, "remote.txt"), "remote\n");
        gitIn(peerRepo, "add remote.txt");
        gitIn(peerRepo, 'commit -m "remote change"');
        gitIn(peerRepo, "push origin main");

        gitIn(localRepo, "fetch origin");
        const beforeSync = await getGitStatus(localRepo);
        expect(beforeSync.ahead).toBe(1);
        expect(beforeSync.behind).toBe(1);

        await syncCurrentBranch(localRepo);

        const afterSync = await getGitStatus(localRepo);
        expect(afterSync.upstream).toBe("origin/main");
        expect(afterSync.ahead).toBe(0);
        expect(afterSync.behind).toBe(0);
      } finally {
        await rm(peerRepo, { recursive: true, force: true });
        await rm(localRepo, { recursive: true, force: true });
        await rm(remoteRepo, { recursive: true, force: true });
      }
    });
  });

  describe("detectReviewProvider", () => {
    it("detects github remotes", () => {
      expect(detectReviewProvider("git@github.com:test/repo.git")).toBe("github");
    });

    it("detects gitlab remotes", () => {
      expect(detectReviewProvider("git@gitlab.com:test/repo.git")).toBe("gitlab");
    });

    it("returns unknown for unsupported hosts", () => {
      expect(detectReviewProvider("git@example.com:test/repo.git")).toBe("unknown");
    });
  });
});
