import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
} from "../src/services/git";

let repoDir: string;

function git(args: string) {
  execSync(`git ${args}`, { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
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

    it("detects untracked files", async () => {
      await writeFile(join(repoDir, "untracked.txt"), "new file");
      const status = await getGitStatus(repoDir);
      const untracked = status.entries.find((e) => e.path === "untracked.txt");
      expect(untracked).toBeTruthy();
      expect(untracked!.status).toBe("untracked");
      git("clean -f untracked.txt");
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
