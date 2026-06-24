import { describe, expect, it } from "vitest";
import type { RepositoryReviewState } from "@codesymphony/shared-types";
import { repositoryReviewsQueryOptions } from "./useRepositoryReviews";

function makeReviewState(
  overrides: Partial<RepositoryReviewState> = {},
): RepositoryReviewState {
  return {
    provider: "github",
    kind: "pr",
    available: true,
    reviewsByBranch: {},
    ...overrides,
  };
}

describe("repositoryReviewsQueryOptions", () => {
  it("structuralSharing tolerates null reviewsByBranch on incoming snapshot", () => {
    const options = repositoryReviewsQueryOptions("repo-1");
    const structuralSharing = options.structuralSharing as (
      prev: RepositoryReviewState | undefined,
      next: RepositoryReviewState,
    ) => RepositoryReviewState;
    const prev = makeReviewState({
      reviewsByBranch: {
        main: {
          number: 1,
          display: "#1",
          url: "https://example.com/pr/1",
          state: "open",
        },
      },
    });
    const next = makeReviewState({
      available: false,
      unavailableReason: "gh is not installed",
      reviewsByBranch: null as unknown as Record<string, never>,
    });

    expect(() => structuralSharing(prev, next)).not.toThrow();
    expect(structuralSharing(prev, next).reviewsByBranch).toEqual(prev.reviewsByBranch);
  });
});