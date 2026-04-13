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
      visibleRepositories: [],
      selectedRepositoryId: "r1",
    })).toBeNull();
  });

  it("keeps the current selection when the selected repository remains visible", () => {
    expect(resolveVisibleRepositorySelection({
      visibleRepositories: [makeRepository("r1"), makeRepository("r2")],
      selectedRepositoryId: "r2",
    })).toBeNull();
  });

  it("falls back to the first visible repository when the selected repository is hidden", () => {
    expect(resolveVisibleRepositorySelection({
      visibleRepositories: [makeRepository("r2"), makeRepository("r3")],
      selectedRepositoryId: "r1",
    })).toEqual({
      repositoryId: "r2",
      worktreeId: "r2-wt-root",
    });
  });
});
