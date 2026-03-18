import { describe, it, expect } from "vitest";
import type { Repository, Worktree } from "@codesymphony/shared-types";
import { areLikelySameFsPath, isRootWorktree, findRootWorktree } from "./worktree";

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: "w1",
    repositoryId: "r1",
    branch: "main",
    path: "/home/project",
    baseBranch: "main",
    status: "active",
    branchRenamed: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "r1",
    name: "repo",
    rootPath: "/home/project",
    defaultBranch: "main",
    setupScript: null,
    teardownScript: null,
    runScript: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    worktrees: [],
    ...overrides,
  };
}

describe("areLikelySameFsPath", () => {
  it("matches identical paths", () => {
    expect(areLikelySameFsPath("/home/user/project", "/home/user/project")).toBe(true);
  });

  it("matches with trailing slash difference", () => {
    expect(areLikelySameFsPath("/home/user/project/", "/home/user/project")).toBe(true);
  });

  it("matches with /private prefix on macOS", () => {
    expect(areLikelySameFsPath("/private/var/folders/abc", "/var/folders/abc")).toBe(true);
    expect(areLikelySameFsPath("/var/folders/abc", "/private/var/folders/abc")).toBe(true);
  });

  it("matches Windows paths case-insensitively for drive letter", () => {
    expect(areLikelySameFsPath("C:/Users/me/project", "c:/Users/me/project")).toBe(true);
  });

  it("converts backslashes to forward slashes", () => {
    expect(areLikelySameFsPath("C:\\Users\\me\\project", "c:/Users/me/project")).toBe(true);
  });

  it("returns false for different paths", () => {
    expect(areLikelySameFsPath("/home/user/a", "/home/user/b")).toBe(false);
  });

  it("handles /private alone", () => {
    expect(areLikelySameFsPath("/private", "/")).toBe(true);
  });

  it("handles Windows drive letter only", () => {
    expect(areLikelySameFsPath("C:", "c:/")).toBe(true);
  });
});

describe("isRootWorktree", () => {
  it("returns true when worktree path matches repo root and is active", () => {
    const worktree = makeWorktree({ path: "/home/project", status: "active" });
    const repo = makeRepository({ rootPath: "/home/project" });
    expect(isRootWorktree(worktree, repo)).toBe(true);
  });

  it("returns false when worktree is not active", () => {
    const worktree = makeWorktree({ path: "/home/project", status: "archived" });
    const repo = makeRepository({ rootPath: "/home/project" });
    expect(isRootWorktree(worktree, repo)).toBe(false);
  });

  it("returns false when paths differ", () => {
    const worktree = makeWorktree({ path: "/home/project/branch", status: "active" });
    const repo = makeRepository({ rootPath: "/home/project" });
    expect(isRootWorktree(worktree, repo)).toBe(false);
  });
});

describe("findRootWorktree", () => {
  it("finds root worktree", () => {
    const repo = makeRepository({
      rootPath: "/home/project",
      worktrees: [
        makeWorktree({ id: "w1", path: "/home/project/branch", status: "active" }),
        makeWorktree({ id: "w2", path: "/home/project", status: "active" }),
      ],
    });
    expect(findRootWorktree(repo)?.id).toBe("w2");
  });

  it("returns null when no root worktree found", () => {
    const repo = makeRepository({
      rootPath: "/home/project",
      worktrees: [
        makeWorktree({ id: "w1", path: "/home/project/branch", status: "active" }),
      ],
    });
    expect(findRootWorktree(repo)).toBeNull();
  });

  it("returns null for empty worktrees", () => {
    const repo = makeRepository({ rootPath: "/home/project", worktrees: [] });
    expect(findRootWorktree(repo)).toBeNull();
  });
});
