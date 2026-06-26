import { describe, expect, it } from "vitest";
import { resolveBranchSyncBadgeState } from "./WorktreeBranchSyncBadge";

describe("resolveBranchSyncBadgeState", () => {
  it("returns null when ahead and behind are both zero", () => {
    expect(resolveBranchSyncBadgeState(0, 0)).toBeNull();
  });

  it("returns behind tone when the branch is behind base", () => {
    expect(resolveBranchSyncBadgeState(0, 3)).toEqual({
      showAhead: false,
      showBehind: true,
      tone: "behind",
    });
  });

  it("returns null when the branch is only ahead", () => {
    expect(resolveBranchSyncBadgeState(2, 0)).toBeNull();
  });

  it("shows behind state when both ahead and behind are positive", () => {
    expect(resolveBranchSyncBadgeState(2, 3)).toEqual({
      showAhead: true,
      showBehind: true,
      tone: "behind",
    });
  });
});
