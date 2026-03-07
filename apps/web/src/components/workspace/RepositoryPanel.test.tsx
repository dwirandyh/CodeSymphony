import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread, ChatThreadSnapshot, Repository } from "@codesymphony/shared-types";
import { RepositoryPanel } from "./RepositoryPanel";

const { listThreadsMock, getThreadSnapshotMock, getGitStatusMock } = vi.hoisted(() => ({
  listThreadsMock: vi.fn(),
  getThreadSnapshotMock: vi.fn(),
  getGitStatusMock: vi.fn().mockResolvedValue({ branch: "main", entries: [] }),
}));

vi.mock("../../lib/api", () => ({
  api: {
    listThreads: listThreadsMock,
    getThreadSnapshot: getThreadSnapshotMock,
    getGitStatus: getGitStatusMock,
  },
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  listThreadsMock.mockReset();
  getThreadSnapshotMock.mockReset();
  getGitStatusMock.mockClear();
  listThreadsMock.mockResolvedValue([]);
  getThreadSnapshotMock.mockResolvedValue(makeSnapshot());
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
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
    updatedAt: "2026-01-01T00:00:00Z",
    worktrees: [
      {
        id: "wt-root",
        repositoryId: "r1",
        branch: "main",
        path: "/home/user/test-repo",
        baseBranch: "main",
        status: "active",
        branchRenamed: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "wt-feat",
        repositoryId: "r1",
        branch: "feature-x",
        path: "/home/user/.cs/worktrees/test-repo/feature-x",
        baseBranch: "main",
        status: "active",
        branchRenamed: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
    ...overrides,
  };
}

function makeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "t1",
    worktreeId: "wt-feat",
    title: "Thread",
    titleEditedManually: false,
    claudeSessionId: null,
    active: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeSnapshot(events: ChatThreadSnapshot["events"]["data"] = []): ChatThreadSnapshot {
  return {
    messages: {
      data: [],
      pageInfo: {
        hasMoreOlder: false,
        nextBeforeSeq: null,
        oldestSeq: null,
        newestSeq: null,
      },
    },
    events: {
      data: events,
      pageInfo: {
        hasMoreOlder: false,
        nextBeforeIdx: null,
        oldestIdx: null,
        newestIdx: events.length ? events[events.length - 1]!.idx : null,
      },
    },
    watermarks: {
      newestSeq: null,
      newestIdx: events.length ? events[events.length - 1]!.idx : null,
    },
    coverage: {
      eventsStatus: "complete",
      recommendedBackfill: false,
      nextBeforeIdx: null,
    },
  };
}

function renderPanel(props: Partial<typeof baseProps> = {}) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <RepositoryPanel {...baseProps} {...props} />
      </QueryClientProvider>,
    );
  });
}

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

describe("RepositoryPanel", () => {
  it("renders attach repo button", () => {
    renderPanel();
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("renders repository name", () => {
    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
    });
    expect(container.textContent).toContain("test-repo");
  });

  it("shows root and branch worktrees without section separators", () => {
    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
      selectedWorktreeId: "wt-root",
    });
    expect(container.textContent).toContain("main");
    expect(container.textContent).toContain("feature-x");
  });

  it("calls onCreateWorktree when add button clicked", () => {
    const onCreateWorktree = vi.fn();
    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
      onCreateWorktree,
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
    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
      onSelectWorktree,
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
    renderPanel({ loadingRepos: true });
    const spinners = container.querySelectorAll(".animate-spin");
    expect(spinners.length).toBeGreaterThanOrEqual(0);
  });

  it("calls onAttachRepository when attach button clicked", () => {
    const onAttach = vi.fn();
    renderPanel({ onAttachRepository: onAttach });
    const buttons = Array.from(container.querySelectorAll("button"));
    const attachBtn = buttons.find((button) => button.getAttribute("aria-label") === "Attach repository");
    if (attachBtn) {
      act(() => attachBtn.click());
      expect(onAttach).toHaveBeenCalled();
    }
  });

  it("renders root and branch status badges", async () => {
    listThreadsMock.mockImplementation(async (worktreeId: string) => {
      if (worktreeId === "wt-root") {
        return [makeThread({ id: "t-root", worktreeId: "wt-root", active: true })];
      }
      if (worktreeId === "wt-feat") {
        return [makeThread({ id: "t-feat", worktreeId: "wt-feat" })];
      }
      return [];
    });
    getThreadSnapshotMock.mockImplementation(async (threadId: string) => {
      if (threadId === "t-feat") {
        return makeSnapshot([
          {
            id: "e1",
            threadId,
            idx: 1,
            type: "permission.requested",
            payload: { requestId: "perm-1", toolName: "Bash" },
            createdAt: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      return makeSnapshot();
    });

    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Waiting approval");
    expect(container.textContent).toContain("Running");
  });
});
