import { describe, expect, it } from "vitest";
import { isBaseBranchSelected, resolveReviewBaseBranch, resolveReviewBranch } from "./reviewBranch";

describe("reviewBranch", () => {
  it("prefers the git status branch when available", () => {
    expect(resolveReviewBranch("feature/live", "main")).toBe("feature/live");
  });

  it("falls back to the cached worktree branch when git status is unavailable", () => {
    expect(resolveReviewBranch("", "feature/cached")).toBe("feature/cached");
  });

  it("prefers the worktree base branch over the repository default branch", () => {
    expect(resolveReviewBaseBranch("release/2026.04", "main")).toBe("release/2026.04");
  });

  it("detects when the selected branch is the base branch", () => {
    expect(isBaseBranchSelected("main", "main")).toBe(true);
    expect(isBaseBranchSelected("feature/foo", "main")).toBe(false);
  });
});
