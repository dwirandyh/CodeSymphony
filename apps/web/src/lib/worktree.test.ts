import { describe, it, expect } from "vitest";
import type { Repository, Worktree } from "@codesymphony/shared-types";
import { areLikelySameFsPath, isRootWorktree, findRootWorktree } from "./worktree";

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
    const worktree = { id: "w1", path: "/home/project", status: "active" } as Worktree;
    const repo = { rootPath: "/home/project" } as Repository;
    expect(isRootWorktree(worktree, repo)).toBe(true);
  });

  it("returns false when worktree is not active", () => {
    const worktree = { id: "w1", path: "/home/project", status: "creating" } as Worktree;
    const repo = { rootPath: "/home/project" } as Repository;
    expect(isRootWorktree(worktree, repo)).toBe(false);
  });

  it("returns false when paths differ", () => {
    const worktree = { id: "w1", path: "/home/project/branch", status: "active" } as Worktree;
    const repo = { rootPath: "/home/project" } as Repository;
    expect(isRootWorktree(worktree, repo)).toBe(false);
  });
});

describe("findRootWorktree", () => {
  it("finds root worktree", () => {
    const repo = {
      rootPath: "/home/project",
      worktrees: [
        { id: "w1", path: "/home/project/branch", status: "active" },
        { id: "w2", path: "/home/project", status: "active" },
      ],
    } as Repository;
    expect(findRootWorktree(repo)?.id).toBe("w2");
  });

  it("returns null when no root worktree found", () => {
    const repo = {
      rootPath: "/home/project",
      worktrees: [
        { id: "w1", path: "/home/project/branch", status: "active" },
      ],
    } as Repository;
    expect(findRootWorktree(repo)).toBeNull();
  });

  it("returns null for empty worktrees", () => {
    const repo = { rootPath: "/home/project", worktrees: [] } as unknown as Repository;
    expect(findRootWorktree(repo)).toBeNull();
  });
});
