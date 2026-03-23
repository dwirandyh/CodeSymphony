import type { PrismaClient } from "@prisma/client";
import type { RepositoryReviewState, ReviewKind, ReviewProvider, ReviewRef, ReviewState } from "@codesymphony/shared-types";
import {
  ensureCliAvailable,
  listGithubPullRequests,
  listGitlabMergeRequests,
  resolveReviewRemote,
  type RemoteReviewRef,
} from "./git.js";

function toReviewKind(provider: ReviewProvider): ReviewKind | null {
  if (provider === "github") return "pr";
  if (provider === "gitlab") return "mr";
  return null;
}

function toReviewDisplay(provider: ReviewProvider, number: number): string {
  return provider === "gitlab" ? `!${number}` : `#${number}`;
}

function mapReviewRef(provider: ReviewProvider, review: RemoteReviewRef): ReviewRef {
  return {
    number: review.number,
    display: toReviewDisplay(provider, review.number),
    url: review.url,
    state: review.state,
  };
}

function reviewPriority(state: ReviewState): number {
  if (state === "open") return 0;
  if (state === "merged") return 1;
  return 2;
}

function compareReviewRecency(a: RemoteReviewRef, b: RemoteReviewRef): number {
  const priorityDelta = reviewPriority(a.state) - reviewPriority(b.state);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const aTime = a.updatedAt ? Date.parse(a.updatedAt) : Number.NEGATIVE_INFINITY;
  const bTime = b.updatedAt ? Date.parse(b.updatedAt) : Number.NEGATIVE_INFINITY;
  if (Number.isNaN(aTime) && Number.isNaN(bTime)) {
    return 0;
  }
  if (Number.isNaN(aTime)) {
    return 1;
  }
  if (Number.isNaN(bTime)) {
    return -1;
  }

  return bTime - aTime;
}

function selectReviewsByBranch(reviews: RemoteReviewRef[]): Record<string, RemoteReviewRef> {
  return reviews.reduce<Record<string, RemoteReviewRef>>((acc, review) => {
    const current = acc[review.headBranch];
    if (!current || compareReviewRecency(review, current) < 0) {
      acc[review.headBranch] = review;
    }
    return acc;
  }, {});
}

function resolveUnavailableReason(provider: ReviewProvider, remoteUrl: string | null): string {
  if (!remoteUrl) {
    return "No git remote found for this worktree";
  }
  if (provider === "unknown") {
    return "Only GitHub and GitLab remotes are supported";
  }
  return "Review integration is unavailable";
}

async function listRemoteReviews(args: {
  cwd: string;
  provider: ReviewProvider;
  baseBranch: string;
}): Promise<RemoteReviewRef[]> {
  if (args.provider === "github") {
    return listGithubPullRequests(args.cwd, args.baseBranch);
  }
  if (args.provider === "gitlab") {
    return listGitlabMergeRequests(args.cwd, args.baseBranch);
  }
  return [];
}

export function createReviewService(prisma: PrismaClient) {
  return {
    async getRepositoryReviews(repositoryId: string): Promise<RepositoryReviewState> {
      const repository = await prisma.repository.findUnique({
        where: { id: repositoryId },
        include: {
          worktrees: {
            where: { status: "active" },
            orderBy: { updatedAt: "desc" },
          },
        },
      });

      if (!repository) {
        throw new Error("Repository not found");
      }

      const inspectionWorktree = repository.worktrees[0];
      if (!inspectionWorktree) {
        return {
          provider: "unknown",
          kind: null,
          available: false,
          unavailableReason: "No active worktrees found",
          reviewsByBranch: {},
        };
      }

      const remote = await resolveReviewRemote(inspectionWorktree.path);
      const kind = toReviewKind(remote.provider);
      if (!kind) {
        return {
          provider: remote.provider,
          kind: null,
          available: false,
          unavailableReason: resolveUnavailableReason(remote.provider, remote.remoteUrl),
          reviewsByBranch: {},
        };
      }

      try {
        await ensureCliAvailable(remote.provider === "github" ? "gh" : "glab");
        const reviews = await listRemoteReviews({
          cwd: inspectionWorktree.path,
          provider: remote.provider,
          baseBranch: repository.defaultBranch,
        });

        return {
          provider: remote.provider,
          kind,
          available: true,
          reviewsByBranch: Object.fromEntries(
            Object.entries(
              selectReviewsByBranch(
                reviews.filter((review) => review.baseBranch === repository.defaultBranch),
              ),
            ).map(([branch, review]) => [branch, mapReviewRef(remote.provider, review)]),
          ),
        };
      } catch (error) {
        return {
          provider: remote.provider,
          kind,
          available: false,
          unavailableReason: error instanceof Error ? error.message : "Review integration is unavailable",
          reviewsByBranch: {},
        };
      }
    },
  };
}
