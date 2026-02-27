import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { RepositoryPanel } from "./RepositoryPanel";

vi.mock("../../lib/api", () => ({
  api: {
    getGitStatus: vi.fn(),
  },
}));

const repository: Repository = {
  id: "repo-1",
  name: "example",
  rootPath: "/tmp/example",
  defaultBranch: "main",
  setupScript: null,
  teardownScript: null,
  runScript: null,
  createdAt: "2026-02-20T00:00:00.000Z",
  updatedAt: "2026-02-20T00:00:00.000Z",
  worktrees: [
    {
      id: "wt-root",
      repositoryId: "repo-1",
      branch: "main",
      path: "/tmp/example",
      baseBranch: "main",
      status: "active",
      branchRenamed: false,
      createdAt: "2026-02-20T00:00:00.000Z",
      updatedAt: "2026-02-20T00:00:00.000Z",
    },
    {
      id: "wt-1",
      repositoryId: "repo-1",
      branch: "feature/test",
      path: "/tmp/worktree-feature-test",
      baseBranch: "main",
      status: "active",
      branchRenamed: false,
      createdAt: "2026-02-20T00:00:00.000Z",
      updatedAt: "2026-02-20T00:00:00.000Z",
    },
  ],
};

function noop() {}

describe("RepositoryPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    vi.mocked(api.getGitStatus).mockResolvedValue({
      branch: "main",
      entries: [],
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  function renderPanel() {
    act(() => {
      root.render(
        <RepositoryPanel
          repositories={[repository]}
          selectedRepositoryId="repo-1"
          selectedWorktreeId="wt-root"
          loadingRepos={false}
          submittingRepo={false}
          submittingWorktree={false}
          onAttachRepository={noop}
          onSelectRepository={noop}
          onCreateWorktree={noop}
          onSelectWorktree={noop}
          onDeleteWorktree={noop}
          onRenameWorktreeBranch={noop}
        />,
      );
    });
  }

  it("shows separate Root Workspace and Worktrees sections", async () => {
    renderPanel();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Root Workspace");
    expect(container.textContent).toContain("Worktrees");
  });

  it("does not render delete action for root workspace row", async () => {
    renderPanel();

    await act(async () => {
      await Promise.resolve();
    });

    const deleteButtons = container.querySelectorAll('button[title="Delete worktree"]');
    expect(deleteButtons.length).toBe(1);
  });
});
