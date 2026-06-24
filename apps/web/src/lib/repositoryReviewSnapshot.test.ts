import { describe, expect, it } from "vitest";
import type { RepositoryReviewState } from "@codesymphony/shared-types";
import { countReviewBranchesInSnapshot, mergeRepositoryReviewSnapshots } from "./repositoryReviewSnapshot";

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

describe("mergeRepositoryReviewSnapshots", () => {
  it("returns incoming snapshot when there is no cached snapshot", () => {
    const incoming = makeReviewState({
      reviewsByBranch: {
        "feature-x": {
          number: 12,
          display: "#12",
          url: "https://example.com/pr/12",
          state: "open",
        },
      },
    });

    expect(mergeRepositoryReviewSnapshots(undefined, incoming)).toEqual(incoming);
  });

  it("applies an available incoming snapshot with review data", () => {
    const current = makeReviewState({
      reviewsByBranch: {
        "feature-x": {
          number: 12,
          display: "#12",
          url: "https://example.com/pr/12",
          state: "open",
        },
      },
    });
    const incoming = makeReviewState({
      reviewsByBranch: {
        "feature-y": {
          number: 29,
          display: "#29",
          url: "https://example.com/pr/29",
          state: "open",
        },
      },
    });

    expect(mergeRepositoryReviewSnapshots(current, incoming)).toEqual(incoming);
  });

  it("keeps cached reviews when an unavailable snapshot would wipe them", () => {
    const current = makeReviewState({
      reviewsByBranch: {
        "feature-x": {
          number: 12,
          display: "#12",
          url: "https://example.com/pr/12",
          state: "open",
        },
      },
    });
    const incoming = makeReviewState({
      available: false,
      unavailableReason: "gh is not installed",
      reviewsByBranch: {},
    });

    expect(mergeRepositoryReviewSnapshots(current, incoming)).toEqual({
      ...incoming,
      reviewsByBranch: current.reviewsByBranch,
    });
  });

  it("accepts an available empty snapshot when there were no cached reviews", () => {
    const incoming = makeReviewState({
      available: true,
      reviewsByBranch: {},
    });

    expect(mergeRepositoryReviewSnapshots(undefined, incoming)).toEqual(incoming);
  });

  it("countReviewBranchesInSnapshot returns zero when reviewsByBranch is null", () => {
    expect(countReviewBranchesInSnapshot(makeReviewState({
      reviewsByBranch: null as unknown as Record<string, never>,
    }))).toBe(0);
  });

  it("does not throw when reviewsByBranch is null on either snapshot", () => {
    const current = makeReviewState({
      reviewsByBranch: {
        "feature-x": {
          number: 12,
          display: "#12",
          url: "https://example.com/pr/12",
          state: "open",
        },
      },
    });
    const incoming = makeReviewState({
      available: false,
      unavailableReason: "gh is not installed",
      reviewsByBranch: null as unknown as Record<string, never>,
    });

    expect(() => mergeRepositoryReviewSnapshots(current, incoming)).not.toThrow();
    expect(mergeRepositoryReviewSnapshots(current, incoming).reviewsByBranch).toEqual(current.reviewsByBranch);
  });
});