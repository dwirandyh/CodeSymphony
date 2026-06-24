import type { RepositoryReviewState } from "@codesymphony/shared-types";

function reviewBranchCount(reviewsByBranch: RepositoryReviewState["reviewsByBranch"] | null | undefined): number {
  return reviewsByBranch ? Object.keys(reviewsByBranch).length : 0;
}

export function countReviewBranchesInSnapshot(state: RepositoryReviewState | undefined): number {
  return reviewBranchCount(state?.reviewsByBranch);
}

function normalizeReviewSnapshot(state: RepositoryReviewState): RepositoryReviewState {
  return {
    ...state,
    reviewsByBranch: state.reviewsByBranch ?? {},
  };
}

export function mergeRepositoryReviewSnapshots(
  current: RepositoryReviewState | undefined,
  incoming: RepositoryReviewState,
): RepositoryReviewState {
  const normalizedIncoming = normalizeReviewSnapshot(incoming);

  if (!current) {
    return normalizedIncoming;
  }

  const normalizedCurrent = normalizeReviewSnapshot(current);
  const currentReviewCount = reviewBranchCount(normalizedCurrent.reviewsByBranch);
  const incomingReviewCount = reviewBranchCount(normalizedIncoming.reviewsByBranch);

  if (!normalizedIncoming.available && currentReviewCount > 0 && incomingReviewCount === 0) {
    return {
      ...normalizedIncoming,
      reviewsByBranch: normalizedCurrent.reviewsByBranch,
      kind: normalizedIncoming.kind ?? normalizedCurrent.kind,
      provider: normalizedIncoming.provider === "unknown" ? normalizedCurrent.provider : normalizedIncoming.provider,
    };
  }

  return normalizedIncoming;
}