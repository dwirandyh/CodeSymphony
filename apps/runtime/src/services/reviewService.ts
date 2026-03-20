import type { PrismaClient } from "@prisma/client";
import type { RepositoryReviewState, ReviewKind, ReviewProvider, ReviewRef } from "@codesymphony/shared-types";
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
  };
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
            reviews
              .filter((review) => review.baseBranch === repository.defaultBranch)
              .map((review) => [review.headBranch, mapReviewRef(remote.provider, review)]),
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
