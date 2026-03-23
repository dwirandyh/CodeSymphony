import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatThread, ChatThreadSnapshot, Repository } from "@codesymphony/shared-types";
import { RepositoryPanel } from "./RepositoryPanel";

const { listThreadsMock, getThreadSnapshotMock, getGitStatusMock, getRepositoryReviewsMock } = vi.hoisted(() => ({
  listThreadsMock: vi.fn(),
  getThreadSnapshotMock: vi.fn(),
  getGitStatusMock: vi.fn().mockResolvedValue({ branch: "main", entries: [] }),
  getRepositoryReviewsMock: vi.fn().mockResolvedValue({ provider: "github", kind: "pr", available: true, reviewsByBranch: {} }),
}));

vi.mock("../../lib/api", () => ({
  api: {
    listThreads: listThreadsMock,
    getThreadSnapshot: getThreadSnapshotMock,
    getGitStatus: getGitStatusMock,
    getRepositoryReviews: getRepositoryReviewsMock,
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
  getGitStatusMock.mockReset();
  getRepositoryReviewsMock.mockReset();
  listThreadsMock.mockResolvedValue([]);
  getThreadSnapshotMock.mockResolvedValue(makeSnapshot());
  getGitStatusMock.mockResolvedValue({ branch: "main", entries: [] });
  getRepositoryReviewsMock.mockResolvedValue({ provider: "github", kind: "pr", available: true, reviewsByBranch: {} });
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
    kind: "default",
    permissionProfile: "default",
    titleEditedManually: false,
    claudeSessionId: null,
    active: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeSnapshot(events: ChatEvent[] = []): ChatThreadSnapshot {
  return {
    messages: [],
    events,
    timeline: {
      timelineItems: [],
      summary: {
        oldestRenderableKey: null,
        oldestRenderableKind: null,
        oldestRenderableMessageId: null,
        oldestRenderableHydrationPending: false,
        headIdentityStable: true,
      },
      newestSeq: null,
      newestIdx: events.length ? events[events.length - 1]!.idx : null,
      messages: [],
      events,
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
    const featureRow = container.querySelector("[data-worktree-id='wt-feat']") as HTMLElement | null;
    expect(featureRow).toBeTruthy();
    act(() => featureRow?.click());
    expect(onSelectWorktree).toHaveBeenCalledWith("r1", "wt-feat", null);
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

  it("renders stacked review and diff metadata", async () => {
    getRepositoryReviewsMock.mockResolvedValue({
      provider: "github",
      kind: "pr",
      available: true,
      reviewsByBranch: {
        "feature-x": { number: 123, display: "#123", url: "https://example.com/pr/123", state: "open" },
      },
    });
    getGitStatusMock.mockResolvedValue({
      branch: "feature-x",
      entries: [{ path: "src/app.ts", status: "modified", insertions: 24, deletions: 3 }],
    });

    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
      selectedWorktreeId: "wt-feat",
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="worktree-wt-feat-review"]')?.textContent).toContain("#123");
    expect(container.querySelector('[data-testid="worktree-wt-feat-review"]')?.textContent).not.toContain("PR");
    expect(container.querySelector('[data-testid="worktree-wt-feat-diff"]')?.textContent).toContain("+24");
    expect(container.querySelector('[data-testid="worktree-wt-feat-diff"]')?.textContent).toContain("-3");
  });

  it("renders merged and closed review states", async () => {
    getRepositoryReviewsMock.mockResolvedValue({
      provider: "github",
      kind: "pr",
      available: true,
      reviewsByBranch: {
        main: { number: 9, display: "#9", url: "https://example.com/pr/9", state: "closed" },
        "feature-x": { number: 123, display: "#123", url: "https://example.com/pr/123", state: "merged" },
      },
    });

    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
      selectedWorktreeId: "wt-feat",
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="worktree-wt-root-review"]')?.textContent).toContain("#9");
    expect(container.querySelector('[data-testid="worktree-wt-feat-review"]')?.textContent).toContain("#123");
    expect(container.querySelector('[data-testid="worktree-wt-root-review"]')?.textContent).not.toContain("PR");
    expect(container.querySelector('[data-testid="worktree-wt-root-review"]')?.getAttribute("title")).toContain("Closed");
    expect(container.querySelector('[data-testid="worktree-wt-feat-review"]')?.getAttribute("title")).toContain("Merged");
  });

  it("keeps review and diff metadata visible on hover-capable worktree rows", async () => {
    getRepositoryReviewsMock.mockResolvedValue({
      provider: "github",
      kind: "pr",
      available: true,
      reviewsByBranch: {
        "feature-x": { number: 123, display: "#123", url: "https://example.com/pr/123", state: "open" },
      },
    });
    getGitStatusMock.mockResolvedValue({
      branch: "feature-x",
      entries: [{ path: "src/app.ts", status: "modified", insertions: 24, deletions: 3 }],
    });

    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
      selectedWorktreeId: "wt-feat",
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="worktree-wt-feat-review"]')?.parentElement?.className).not.toContain("group-hover/wt:opacity-0");
    expect(container.querySelector('[data-testid="worktree-wt-feat-diff"]')?.parentElement?.className).not.toContain("group-hover/wt:opacity-0");
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

  it("derives review-plan status from a non-latest inactive thread and forwards that thread on click", async () => {
    const onSelectWorktree = vi.fn();
    listThreadsMock.mockImplementation(async (worktreeId: string) => {
      if (worktreeId === "wt-root") {
        return [makeThread({ id: "t-root", worktreeId: "wt-root" })];
      }
      if (worktreeId === "wt-feat") {
        return [
          makeThread({ id: "t-plan", worktreeId: "wt-feat", title: "Needs review", updatedAt: "2026-01-01T00:00:00Z" }),
          makeThread({ id: "t-latest", worktreeId: "wt-feat", title: "Latest idle", updatedAt: "2026-01-02T00:00:00Z" }),
        ];
      }
      return [];
    });
    getThreadSnapshotMock.mockImplementation(async (threadId: string) => {
      if (threadId === "t-plan") {
        return makeSnapshot([
          {
            id: "e1",
            threadId,
            idx: 1,
            type: "plan.created",
            payload: { content: "Plan", filePath: ".claude/plan.md" },
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "e2",
            threadId,
            idx: 2,
            type: "chat.completed",
            payload: {},
            createdAt: "2026-01-01T00:00:01Z",
          },
        ]);
      }
      return makeSnapshot();
    });

    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
      onSelectWorktree,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Review plan");

    const featureRow = container.querySelector("[data-worktree-id='wt-feat']") as HTMLElement | null;
    expect(featureRow).toBeTruthy();
    act(() => featureRow?.click());

    expect(onSelectWorktree).toHaveBeenCalledWith("r1", "wt-feat", "t-plan");
  });
});
