import { beforeEach, describe, expect, it, vi } from "vitest";

const gitMocks = vi.hoisted(() => ({
  ensureCliAvailable: vi.fn(),
  listGithubPullRequests: vi.fn(),
  listGitlabMergeRequests: vi.fn(),
  resolveReviewRemote: vi.fn(),
}));

vi.mock("../src/services/git.js", () => gitMocks);

import { createReviewService } from "../src/services/reviewService";

function createPrismaMock() {
  return {
    repository: {
      findUnique: vi.fn(),
    },
  } as const;
}

describe("reviewService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps repository reviews by branch for GitHub", async () => {
    const prisma = createPrismaMock();
    prisma.repository.findUnique.mockResolvedValue({
      id: "r1",
      defaultBranch: "main",
      worktrees: [{ id: "w1", path: "/tmp/w1", branch: "feature-x", status: "active" }],
    });
    gitMocks.resolveReviewRemote.mockResolvedValue({ remote: "origin", remoteUrl: "git@github.com:test/repo.git", provider: "github" });
    gitMocks.ensureCliAvailable.mockResolvedValue(undefined);
    gitMocks.listGithubPullRequests.mockResolvedValue([
      { number: 12, url: "https://example.com/pr/12", headBranch: "feature-x", baseBranch: "main", state: "open", updatedAt: "2026-03-20T00:00:00Z" },
      { number: 22, url: "https://example.com/pr/22", headBranch: "feature-y", baseBranch: "develop", state: "closed", updatedAt: "2026-03-21T00:00:00Z" },
    ]);

    const service = createReviewService(prisma as never);
    const result = await service.getRepositoryReviews("r1");

    expect(result.available).toBe(true);
    expect(result.kind).toBe("pr");
    expect(result.reviewsByBranch["feature-x"]?.display).toBe("#12");
    expect(result.reviewsByBranch["feature-x"]?.state).toBe("open");
    expect(result.reviewsByBranch["feature-y"]).toBeUndefined();
    expect(gitMocks.listGithubPullRequests).toHaveBeenCalledWith("/tmp/w1", "main");
  });

  it("prefers an open review over newer merged or closed reviews for the same branch", async () => {
    const prisma = createPrismaMock();
    prisma.repository.findUnique.mockResolvedValue({
      id: "r1",
      defaultBranch: "main",
      worktrees: [{ id: "w1", path: "/tmp/w1", branch: "feature-x", status: "active" }],
    });
    gitMocks.resolveReviewRemote.mockResolvedValue({ remote: "origin", remoteUrl: "git@github.com:test/repo.git", provider: "github" });
    gitMocks.ensureCliAvailable.mockResolvedValue(undefined);
    gitMocks.listGithubPullRequests.mockResolvedValue([
      { number: 30, url: "https://example.com/pr/30", headBranch: "feature-x", baseBranch: "main", state: "merged", updatedAt: "2026-03-21T00:00:00Z" },
      { number: 12, url: "https://example.com/pr/12", headBranch: "feature-x", baseBranch: "main", state: "open", updatedAt: "2026-03-20T00:00:00Z" },
      { number: 5, url: "https://example.com/pr/5", headBranch: "feature-x", baseBranch: "main", state: "closed", updatedAt: "2026-03-22T00:00:00Z" },
    ]);

    const service = createReviewService(prisma as never);
    const result = await service.getRepositoryReviews("r1");

    expect(result.reviewsByBranch["feature-x"]).toEqual({
      number: 12,
      display: "#12",
      url: "https://example.com/pr/12",
      state: "open",
    });
  });

  it("falls back to the most recent merged or closed review when no open review exists", async () => {
    const prisma = createPrismaMock();
    prisma.repository.findUnique.mockResolvedValue({
      id: "r1",
      defaultBranch: "main",
      worktrees: [{ id: "w1", path: "/tmp/w1", branch: "feature-x", status: "active" }],
    });
    gitMocks.resolveReviewRemote.mockResolvedValue({ remote: "origin", remoteUrl: "git@gitlab.com:test/repo.git", provider: "gitlab" });
    gitMocks.ensureCliAvailable.mockResolvedValue(undefined);
    gitMocks.listGitlabMergeRequests.mockResolvedValue([
      { number: 7, url: "https://example.com/mr/7", headBranch: "feature-x", baseBranch: "main", state: "closed", updatedAt: "2026-03-20T00:00:00Z" },
      { number: 8, url: "https://example.com/mr/8", headBranch: "feature-x", baseBranch: "main", state: "merged", updatedAt: "2026-03-21T00:00:00Z" },
    ]);

    const service = createReviewService(prisma as never);
    const result = await service.getRepositoryReviews("r1");

    expect(result.kind).toBe("mr");
    expect(result.reviewsByBranch["feature-x"]).toEqual({
      number: 8,
      display: "!8",
      url: "https://example.com/mr/8",
      state: "merged",
    });
  });

  it("returns unavailable state when cli lookup fails", async () => {
    const prisma = createPrismaMock();
    prisma.repository.findUnique.mockResolvedValue({
      id: "r1",
      defaultBranch: "main",
      worktrees: [{ id: "w1", path: "/tmp/w1", branch: "feature-x", status: "active" }],
    });
    gitMocks.resolveReviewRemote.mockResolvedValue({ remote: "origin", remoteUrl: "git@github.com:test/repo.git", provider: "github" });
    gitMocks.ensureCliAvailable.mockRejectedValue(new Error("gh is not installed"));

    const service = createReviewService(prisma as never);
    const result = await service.getRepositoryReviews("r1");

    expect(result.available).toBe(false);
    expect(result.unavailableReason).toContain("gh is not installed");
  });
});
