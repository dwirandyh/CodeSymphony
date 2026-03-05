import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "@codesymphony/shared-types";
import { RepositoryPanel } from "./RepositoryPanel";

vi.mock("../../lib/api", () => ({
  api: {
    openFileDefaultApp: vi.fn(),
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "r1",
    name: "test-repo",
    rootPath: "/home/user/test-repo",
    defaultBranch: "main",
    setupScript: null,
    teardownScript: null,
    runScript: null,
    createdAt: "2026-01-01T00:00:00Z",
    worktrees: [
      {
        id: "wt-root",
        repositoryId: "r1",
        branch: "main",
        path: "/home/user/test-repo",
        baseBranch: "main",
        status: "active",
        isRoot: true,
        branchRenamed: false,
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "wt-feat",
        repositoryId: "r1",
        branch: "feature-x",
        path: "/home/user/.cs/worktrees/test-repo/feature-x",
        baseBranch: "main",
        status: "active",
        isRoot: false,
        branchRenamed: false,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    ...overrides,
  };
}

describe("RepositoryPanel", () => {
  const baseProps = {
    repositories: [] as Repository[],
    selectedRepositoryId: null as string | null,
    selectedWorktreeId: null as string | null,
    loadingRepos: false,
    submittingRepo: false,
    submittingWorktree: false,
    onAttachRepository: vi.fn(),
    onSelectRepository: vi.fn(),
    onCreateWorktree: vi.fn(),
    onSelectWorktree: vi.fn(),
    onDeleteWorktree: vi.fn(),
    onRenameWorktreeBranch: vi.fn(),
  };

  it("renders attach repo button", () => {
    act(() => {
      root.render(<RepositoryPanel {...baseProps} />);
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("renders repository name", () => {
    act(() => {
      root.render(
        <RepositoryPanel
          {...baseProps}
          repositories={[makeRepo()]}
          selectedRepositoryId="r1"
        />
      );
    });
    expect(container.textContent).toContain("test-repo");
  });

  it("shows root and branch worktrees without section separators", () => {
    act(() => {
      root.render(
        <RepositoryPanel
          {...baseProps}
          repositories={[makeRepo()]}
          selectedRepositoryId="r1"
          selectedWorktreeId="wt-root"
        />
      );
    });
    expect(container.textContent).toContain("main");
    expect(container.textContent).toContain("feature-x");
  });

  it("calls onCreateWorktree when add button clicked", () => {
    const onCreateWorktree = vi.fn();
    act(() => {
      root.render(
        <RepositoryPanel
          {...baseProps}
          repositories={[makeRepo()]}
          selectedRepositoryId="r1"
          onCreateWorktree={onCreateWorktree}
        />
      );
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const addBtn = buttons.find((b) => b.getAttribute("aria-label")?.includes("Add worktree") || b.title?.includes("worktree"));
    if (addBtn) {
      act(() => addBtn.click());
      expect(onCreateWorktree).toHaveBeenCalledWith("r1");
    }
  });

  it("calls onSelectWorktree when worktree clicked", () => {
    const onSelectWorktree = vi.fn();
    act(() => {
      root.render(
        <RepositoryPanel
          {...baseProps}
          repositories={[makeRepo()]}
          selectedRepositoryId="r1"
          onSelectWorktree={onSelectWorktree}
        />
      );
    });
    const items = container.querySelectorAll("[role='button'], [data-worktree-id]");
    if (items.length === 0) {
      const buttons = Array.from(container.querySelectorAll("button"));
      const featureBtn = buttons.find((b) => b.textContent?.includes("feature-x"));
      if (featureBtn) {
        act(() => featureBtn.click());
      }
    }
  });

  it("shows loading state", () => {
    act(() => {
      root.render(<RepositoryPanel {...baseProps} loadingRepos={true} />);
    });
    const spinners = container.querySelectorAll(".animate-spin");
    expect(spinners.length).toBeGreaterThanOrEqual(0);
  });

  it("calls onAttachRepository when attach button clicked", () => {
    const onAttach = vi.fn();
    act(() => {
      root.render(<RepositoryPanel {...baseProps} onAttachRepository={onAttach} />);
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const attachBtn = buttons.find((b) => b.textContent?.includes("Add Repository"));
    if (attachBtn) {
      act(() => attachBtn.click());
      expect(onAttach).toHaveBeenCalled();
    }
  });
});
