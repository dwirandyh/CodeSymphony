/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeBranchSyncBadge } from "./WorktreeBranchSyncBadge";

describe("WorktreeBranchSyncBadge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("does not render when the branch is only ahead of base", () => {
    act(() => {
      root.render(
        <WorktreeBranchSyncBadge
          ahead={2}
          behind={0}
          testId="worktree-w1"
        />,
      );
    });

    expect(container.querySelector('[data-testid="worktree-w1-branch-sync"]')).toBeNull();
  });

  it("renders a non-interactive stale badge when behind base", () => {
    act(() => {
      root.render(
        <WorktreeBranchSyncBadge
          ahead={1}
          behind={3}
          baseBranch="master"
          testId="worktree-w1"
        />,
      );
    });

    const badge = container.querySelector('[data-testid="worktree-w1-branch-sync"]');
    expect(badge?.tagName).toBe("SPAN");
    expect(badge?.textContent).toContain("3");
    expect(badge?.getAttribute("title")).toContain("sync manually");
  });
});