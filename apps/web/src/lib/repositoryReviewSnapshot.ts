import type { RepositoryReviewState } from "@codesymphony/shared-types";

export function mergeRepositoryReviewSnapshots(
  current: RepositoryReviewState | undefined,
  incoming: RepositoryReviewState,
): RepositoryReviewState {
  if (!current) {
    return incoming;
  }

  const currentReviewCount = Object.keys(current.reviewsByBranch).length;
  const incomingReviewCount = Object.keys(incoming.reviewsByBranch).length;

  if (!incoming.available && currentReviewCount > 0 && incomingReviewCount === 0) {
    return {
      ...incoming,
      reviewsByBranch: current.reviewsByBranch,
      kind: incoming.kind ?? current.kind,
      provider: incoming.provider === "unknown" ? current.provider : incoming.provider,
    };
  }

  return incoming;
}