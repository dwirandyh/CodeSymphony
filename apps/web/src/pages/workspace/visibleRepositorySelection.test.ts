import { describe, expect, it } from "vitest";
import type { Repository } from "@codesymphony/shared-types";
import { resolveVisibleRepositorySelection } from "./visibleRepositorySelection";

function makeRepository(id: string, branch = "main"): Repository {
  return {
    id,
    name: id,
    rootPath: `/tmp/${id}`,
    defaultBranch: branch,
    setupScript: null,
    teardownScript: null,
    runScript: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    worktrees: [
      {
        id: `${id}-wt-root`,
        repositoryId: id,
        branch,
        path: `/tmp/${id}`,
        baseBranch: branch,
        status: "active",
        branchRenamed: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
  };
}

describe("resolveVisibleRepositorySelection", () => {
  it("keeps the current selection when no repositories are visible", () => {
    expect(resolveVisibleRepositorySelection({
      allRepositories: [],
      visibleRepositories: [],
      selectedRepositoryId: "r1",
      selectedWorktreeId: "r1-wt-root",
    })).toBeNull();
  });

  it("keeps the current selection when the selected repository remains visible", () => {
    expect(resolveVisibleRepositorySelection({
      allRepositories: [makeRepository("r1"), makeRepository("r2")],
      visibleRepositories: [makeRepository("r1"), makeRepository("r2")],
      selectedRepositoryId: "r2",
      selectedWorktreeId: "r2-wt-root",
    })).toBeNull();
  });

  it("keeps the current selection when the selected worktree remains visible", () => {
    expect(resolveVisibleRepositorySelection({
      allRepositories: [makeRepository("r1"), makeRepository("r2")],
      visibleRepositories: [makeRepository("r1"), makeRepository("r2")],
      selectedRepositoryId: null,
      selectedWorktreeId: "r2-wt-root",
    })).toBeNull();
  });

  it("waits for a visible desired worktree instead of falling back", () => {
    expect(resolveVisibleRepositorySelection({
      allRepositories: [makeRepository("r1"), makeRepository("r2")],
      visibleRepositories: [makeRepository("r1"), makeRepository("r2")],
      selectedRepositoryId: null,
      selectedWorktreeId: null,
      desiredWorktreeId: "r2-wt-root",
    })).toBeNull();
  });

  it("waits for a visible desired repository instead of falling back", () => {
    expect(resolveVisibleRepositorySelection({
      allRepositories: [makeRepository("r1"), makeRepository("r2")],
      visibleRepositories: [makeRepository("r1"), makeRepository("r2")],
      selectedRepositoryId: null,
      selectedWorktreeId: null,
      desiredRepositoryId: "r2",
    })).toBeNull();
  });

  it("waits when the desired repository exists but is currently hidden", () => {
    expect(resolveVisibleRepositorySelection({
      allRepositories: [makeRepository("r1"), makeRepository("r2"), makeRepository("r3")],
      visibleRepositories: [makeRepository("r2"), makeRepository("r3")],
      selectedRepositoryId: null,
      selectedWorktreeId: null,
      desiredRepositoryId: "r1",
      desiredWorktreeId: "r1-wt-root",
    })).toBeNull();
  });

  it("falls back to the first visible repository when the selected repository is hidden", () => {
    expect(resolveVisibleRepositorySelection({
      allRepositories: [makeRepository("r1"), makeRepository("r2"), makeRepository("r3")],
      visibleRepositories: [makeRepository("r2"), makeRepository("r3")],
      selectedRepositoryId: "r1",
      selectedWorktreeId: "r1-wt-root",
    })).toEqual({
      repositoryId: "r2",
      worktreeId: "r2-wt-root",
    });
  });

  it("falls back when the desired selection points to a hidden repository", () => {
    expect(resolveVisibleRepositorySelection({
      allRepositories: [makeRepository("r2"), makeRepository("r3")],
      visibleRepositories: [makeRepository("r2"), makeRepository("r3")],
      selectedRepositoryId: null,
      selectedWorktreeId: null,
      desiredRepositoryId: "r1",
      desiredWorktreeId: "r1-wt-root",
    })).toEqual({
      repositoryId: "r2",
      worktreeId: "r2-wt-root",
    });
  });
});
