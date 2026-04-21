import { describe, it, expect } from "vitest";
import type { Repository, Worktree } from "@codesymphony/shared-types";
import {
  areLikelySameFsPath,
  findRootWorktree,
  isRootWorktree,
  parseFileLocation,
  resolveWorktreeRelativePath,
  serializeFileLocation,
  stripFileLocationSuffix,
  toWorktreeRelativePath,
} from "./worktree";

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

  it("matches trimmed paths", () => {
    expect(areLikelySameFsPath("  /home/user/project  ", "/home/user/project")).toBe(true);
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

describe("stripFileLocationSuffix", () => {
  it("removes markdown line anchors", () => {
    expect(stripFileLocationSuffix("/home/project/src/file.ts#L42")).toBe("/home/project/src/file.ts");
  });

  it("removes line and column suffixes", () => {
    expect(stripFileLocationSuffix("/home/project/src/file.ts:42:7")).toBe("/home/project/src/file.ts");
  });
});

describe("parseFileLocation", () => {
  it("parses GitHub-style line anchors", () => {
    expect(parseFileLocation("/home/project/src/file.ts#L42")).toEqual({
      path: "/home/project/src/file.ts",
      line: 42,
      column: null,
    });
  });

  it("parses GitHub-style line and column anchors", () => {
    expect(parseFileLocation("/home/project/src/file.ts#L42C7")).toEqual({
      path: "/home/project/src/file.ts",
      line: 42,
      column: 7,
    });
  });

  it("parses line and column suffixes", () => {
    expect(parseFileLocation("/home/project/src/file.ts:42:7")).toEqual({
      path: "/home/project/src/file.ts",
      line: 42,
      column: 7,
    });
  });
});

describe("serializeFileLocation", () => {
  it("serializes a line anchor", () => {
    expect(serializeFileLocation("src/file.ts", 42)).toBe("src/file.ts#L42");
  });

  it("serializes a line and column anchor", () => {
    expect(serializeFileLocation("src/file.ts", 42, 7)).toBe("src/file.ts#L42C7");
  });
});

describe("toWorktreeRelativePath", () => {
  it("returns a relative path for files inside the worktree", () => {
    expect(
      toWorktreeRelativePath("/home/project", "/home/project/src/file.ts"),
    ).toBe("src/file.ts");
  });

  it("handles file references with line anchors", () => {
    expect(
      toWorktreeRelativePath("/home/project", "/home/project/src/file.ts#L42"),
    ).toBe("src/file.ts");
  });

  it("returns null for files outside the worktree", () => {
    expect(
      toWorktreeRelativePath("/home/project", "/home/other/file.ts"),
    ).toBeNull();
  });
});

describe("resolveWorktreeRelativePath", () => {
  it("falls back to a unique suffix match when the absolute root differs", () => {
    expect(
      resolveWorktreeRelativePath(
        "/Users/dwirandyh/Work/algostudio/philips-marketing-2019-android",
        "/Users/dwirandyh/Work/algostudio/marketing-2019-android/app/src/main/java/com/example/MainActivity.java#L53",
        [
          "app/src/main/java/com/example/MainActivity.java",
          "app/src/main/java/com/example/OtherActivity.java",
        ],
      ),
    ).toBe("app/src/main/java/com/example/MainActivity.java");
  });

  it("returns null when the suffix match is ambiguous or missing", () => {
    expect(
      resolveWorktreeRelativePath(
        "/Users/dwirandyh/Work/algostudio/philips-marketing-2019-android",
        "/Users/dwirandyh/Work/algostudio/marketing-2019-android/app/src/main/java/com/example/MainActivity.java",
        [],
      ),
    ).toBeNull();
  });
});
