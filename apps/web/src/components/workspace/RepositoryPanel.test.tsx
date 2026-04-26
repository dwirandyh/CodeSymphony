import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread, ChatThreadStatusSnapshot, Repository } from "@codesymphony/shared-types";
import { RepositoryPanel } from "./RepositoryPanel";

const { listThreadsMock, getThreadStatusSnapshotMock, getGitBranchDiffSummaryMock, getRepositoryReviewsMock } = vi.hoisted(() => ({
  listThreadsMock: vi.fn(),
  getThreadStatusSnapshotMock: vi.fn(),
  getGitBranchDiffSummaryMock: vi.fn().mockResolvedValue({ branch: "main", baseBranch: "main", insertions: 0, deletions: 0, filesChanged: 0, available: true }),
  getRepositoryReviewsMock: vi.fn().mockResolvedValue({ provider: "github", kind: "pr", available: true, reviewsByBranch: {} }),
}));
const isTauriDesktopMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api", () => ({
  api: {
    listThreads: listThreadsMock,
    getThreadStatusSnapshot: getThreadStatusSnapshotMock,
    getGitBranchDiffSummary: getGitBranchDiffSummaryMock,
    getRepositoryReviews: getRepositoryReviewsMock,
  },
}));
vi.mock("../../lib/openExternalUrl", async () => {
  const actual = await vi.importActual<typeof import("../../lib/openExternalUrl")>("../../lib/openExternalUrl");

  return {
    ...actual,
    isTauriDesktop: isTauriDesktopMock,
  };
});

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
  getThreadStatusSnapshotMock.mockReset();
  getGitBranchDiffSummaryMock.mockReset();
  getRepositoryReviewsMock.mockReset();
  isTauriDesktopMock.mockReset();
  listThreadsMock.mockResolvedValue([]);
  getThreadStatusSnapshotMock.mockResolvedValue(makeStatusSnapshot());
  getGitBranchDiffSummaryMock.mockResolvedValue({ branch: "main", baseBranch: "main", insertions: 0, deletions: 0, filesChanged: 0, available: true });
  getRepositoryReviewsMock.mockResolvedValue({ provider: "github", kind: "pr", available: true, reviewsByBranch: {} });
  isTauriDesktopMock.mockReturnValue(false);
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
});

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  const repositoryId = overrides.id ?? "r1";
  const defaultName = overrides.name ?? "test-repo";
  const defaultRootPath = overrides.rootPath ?? `/home/user/${defaultName}`;

  return {
    id: repositoryId,
    name: defaultName,
    rootPath: defaultRootPath,
    defaultBranch: "main",
    setupScript: null,
    teardownScript: null,
    runScript: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    worktrees: overrides.worktrees ?? [
      {
        id: `${repositoryId}-wt-root`,
        repositoryId,
        branch: "main",
        path: defaultRootPath,
        baseBranch: "main",
        status: "active",
        branchRenamed: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: `${repositoryId}-wt-feat`,
        repositoryId,
        branch: "feature-x",
        path: `/home/user/.cs/worktrees/${defaultName}/feature-x`,
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
    worktreeId: "r1-wt-feat",
    title: "Thread",
    kind: "default",
    permissionProfile: "default",
    permissionMode: "default",
    mode: "default",
    titleEditedManually: false,
    claudeSessionId: null,
    active: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeStatusSnapshot(
  overrides: Partial<ChatThreadStatusSnapshot> = {},
): ChatThreadStatusSnapshot {
  return {
    status: "idle",
    newestIdx: null,
    ...overrides,
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
  hiddenRepositoryIds: [] as string[],
  expandedByRepo: {} as Record<string, boolean>,
  loadingRepos: false,
  submittingRepo: false,
  submittingWorktree: false,
  onAttachRepository: vi.fn(),
  onSelectRepository: vi.fn(),
  onToggleRepositoryExpand: vi.fn(),
  onSetRepositoryVisibility: vi.fn(),
  onShowAllRepositories: vi.fn(),
  onReorderRepositories: vi.fn(),
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
      selectedWorktreeId: "r1-wt-root",
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
    const featureRow = container.querySelector("[data-worktree-id='r1-wt-feat']") as HTMLElement | null;
    expect(featureRow).toBeTruthy();
    act(() => featureRow?.click());
    expect(onSelectWorktree).toHaveBeenCalledWith("r1", "r1-wt-feat", null);
  });

  it("collapses the selected repository on the first toggle after initial render", () => {
    function Harness() {
      const [expandedByRepo, setExpandedByRepo] = useState<Record<string, boolean>>({});

      return (
        <QueryClientProvider client={queryClient}>
          <RepositoryPanel
            {...baseProps}
            repositories={[makeRepo()]}
            selectedRepositoryId="r1"
            selectedWorktreeId="r1-wt-feat"
            expandedByRepo={expandedByRepo}
            onToggleRepositoryExpand={(repositoryId, nextExpanded) => {
              setExpandedByRepo((current) => ({
                ...current,
                [repositoryId]: nextExpanded,
              }));
            }}
          />
        </QueryClientProvider>
      );
    }

    act(() => {
      root.render(<Harness />);
    });

    expect(container.querySelector("[data-worktree-id='r1-wt-feat']")).toBeTruthy();

    const repoToggle = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("test-repo"));
    expect(repoToggle).toBeTruthy();

    act(() => repoToggle?.click());

    expect(container.querySelector("[data-worktree-id='r1-wt-feat']")).toBeNull();
  });

  it("keeps the repository chevron from shrinking in tight layouts", () => {
    renderPanel({
      repositories: [makeRepo({ name: "repository-name-that-is-long-enough-to-compete-with-the-count" })],
      selectedRepositoryId: "r1",
    });

    const repoToggle = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("repository-name-that-is-long-enough"));
    const chevronSlot = repoToggle?.querySelector("span");

    expect(chevronSlot?.className).toContain("shrink-0");
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

  it("hides repositories excluded by the workspace filter", () => {
    renderPanel({
      repositories: [
        makeRepo({ id: "r1", name: "repo-one" }),
        makeRepo({ id: "r2", name: "repo-two" }),
      ],
      selectedRepositoryId: "r1",
      hiddenRepositoryIds: ["r2"],
    });

    expect(container.querySelector('[data-testid="repository-r1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="repository-r2"]')).toBeNull();
    expect(container.textContent).toContain("Workspace (1/2)");
  });

  it("updates workspace visibility from the filter popover", () => {
    const onSetRepositoryVisibility = vi.fn();

    renderPanel({
      repositories: [
        makeRepo({ id: "r1", name: "repo-one" }),
        makeRepo({ id: "r2", name: "repo-two" }),
      ],
      onSetRepositoryVisibility,
    });

    const filterButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Filter workspaces");
    expect(filterButton).toBeTruthy();

    act(() => filterButton?.click());

    const repoTwoToggle = Array.from(document.querySelectorAll("input"))
      .find((input) => input instanceof HTMLInputElement && input.nextElementSibling?.textContent === "repo-two") as HTMLInputElement | undefined;
    expect(repoTwoToggle).toBeTruthy();

    act(() => {
      repoTwoToggle?.click();
    });

    expect(onSetRepositoryVisibility).toHaveBeenCalledWith("r2", false);
  });

  it("forwards repository reorder events from drag and drop", () => {
    const onReorderRepositories = vi.fn();

    renderPanel({
      repositories: [
        makeRepo({ id: "r1", name: "repo-one" }),
        makeRepo({ id: "r2", name: "repo-two" }),
      ],
      selectedRepositoryId: "r1",
      onReorderRepositories,
    });

    const dragSource = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("repo-one"));
    const target = container.querySelector('[data-testid="repository-r2"]') as HTMLElement | null;

    expect(dragSource).toBeTruthy();
    expect(target).toBeTruthy();

    Object.defineProperty(target, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    const setDragImage = vi.fn();
    const dragStartEvent = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStartEvent, "dataTransfer", {
      value: {
        effectAllowed: "move",
        setData: vi.fn(),
        setDragImage,
      },
    });

    const dragOverEvent = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragOverEvent, "clientY", { value: 80 });
    Object.defineProperty(dragOverEvent, "dataTransfer", {
      value: {
        dropEffect: "move",
      },
    });

    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, "clientY", { value: 80 });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: {
        getData: () => "r1",
      },
    });

    act(() => {
      dragSource?.dispatchEvent(dragStartEvent);
      target?.dispatchEvent(dragOverEvent);
    });

    const previewOrder = Array.from(container.querySelectorAll('[data-testid^="repository-"]'))
      .map((element) => element.getAttribute("data-testid"));

    expect(previewOrder).toEqual(["repository-r2", "repository-r1"]);
    expect(onReorderRepositories).not.toHaveBeenCalled();

    act(() => {
      target?.dispatchEvent(dropEvent);
    });

    expect(onReorderRepositories).toHaveBeenCalledWith("r1", "r2", "after");
  });

  it("allows dragover to stay droppable when the drag source only exists in dataTransfer", () => {
    renderPanel({
      repositories: [
        makeRepo({ id: "r1", name: "repo-one" }),
        makeRepo({ id: "r2", name: "repo-two" }),
      ],
      selectedRepositoryId: "r1",
    });

    const target = container.querySelector('[data-testid="repository-r2"]') as HTMLElement | null;
    expect(target).toBeTruthy();

    Object.defineProperty(target, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    const dragOverEvent = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragOverEvent, "clientY", { value: 20 });
    Object.defineProperty(dragOverEvent, "dataTransfer", {
      value: {
        dropEffect: "move",
        getData: () => "r1",
      },
    });

    act(() => {
      target?.dispatchEvent(dragOverEvent);
    });

    expect(dragOverEvent.defaultPrevented).toBe(true);
    const previewOrder = Array.from(container.querySelectorAll('[data-testid^="repository-"]'))
      .map((element) => element.getAttribute("data-testid"));
    expect(previewOrder).toEqual(["repository-r1", "repository-r2"]);
  });

  it("persists the last previewed reorder even if drop lands on the dragged container", () => {
    const onReorderRepositories = vi.fn();

    renderPanel({
      repositories: [
        makeRepo({ id: "r1", name: "repo-one" }),
        makeRepo({ id: "r2", name: "repo-two" }),
      ],
      selectedRepositoryId: "r1",
      onReorderRepositories,
    });

    const dragSource = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("repo-one"));
    const target = container.querySelector('[data-testid="repository-r2"]') as HTMLElement | null;

    expect(dragSource).toBeTruthy();
    expect(target).toBeTruthy();

    Object.defineProperty(target, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    const setDragImage = vi.fn();
    const dragStartEvent = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStartEvent, "dataTransfer", {
      value: {
        effectAllowed: "move",
        setData: vi.fn(),
        setDragImage,
      },
    });

    const dragOverEvent = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragOverEvent, "clientY", { value: 80 });
    Object.defineProperty(dragOverEvent, "dataTransfer", {
      value: {
        dropEffect: "move",
      },
    });

    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, "clientY", { value: 80 });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: {
        getData: () => "r1",
      },
    });

    act(() => {
      dragSource?.dispatchEvent(dragStartEvent);
      target?.dispatchEvent(dragOverEvent);
      dragSource?.dispatchEvent(dropEvent);
    });

    expect(onReorderRepositories).toHaveBeenCalledWith("r1", "r2", "after");
  });

  it("shows the brighter repository container only during drag while keeping the workspace row as the drag handle", async () => {
    renderPanel({
      repositories: [
        makeRepo({ id: "r1", name: "repo-one" }),
        makeRepo({ id: "r2", name: "repo-two" }),
      ],
      selectedRepositoryId: "r1",
    });

    const repositoryCard = container.querySelector('[data-testid="repository-r1"]') as HTMLElement | null;
    const dragSource = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("repo-one"));

    expect(repositoryCard).toBeTruthy();
    expect(repositoryCard?.className).toContain("rounded-xl");
    expect(repositoryCard?.className).not.toContain("bg-secondary/20");
    expect(repositoryCard?.className).not.toContain("border-border/40");
    expect(dragSource?.getAttribute("draggable")).toBe("true");

    const setDragImage = vi.fn();
    const dragStartEvent = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStartEvent, "dataTransfer", {
      value: {
        effectAllowed: "move",
        setData: vi.fn(),
        setDragImage,
      },
    });

    act(() => {
      dragSource?.dispatchEvent(dragStartEvent);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const otherRepositoryCard = container.querySelector('[data-testid="repository-r2"]') as HTMLElement | null;
    expect(setDragImage).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="repository-r1"]')).toBeNull();
    expect(otherRepositoryCard?.className).not.toContain("bg-secondary/20");
    expect(otherRepositoryCard?.className).not.toContain("border-border/40");
  });

  it("hides the dragged repository from the list until drop finishes", async () => {
    renderPanel({
      repositories: [
        makeRepo({ id: "r1", name: "repo-one" }),
        makeRepo({ id: "r2", name: "repo-two" }),
      ],
      selectedRepositoryId: "r1",
    });

    const dragSource = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("repo-one"));
    const target = container.querySelector('[data-testid="repository-r2"]') as HTMLElement | null;

    const dragStartEvent = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStartEvent, "dataTransfer", {
      value: {
        effectAllowed: "move",
        setData: vi.fn(),
        setDragImage: vi.fn(),
      },
    });

    Object.defineProperty(target, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    const dragOverEvent = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragOverEvent, "clientY", { value: 80 });
    Object.defineProperty(dragOverEvent, "dataTransfer", {
      value: {
        dropEffect: "move",
      },
    });

    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, "clientY", { value: 80 });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: {
        getData: () => "r1",
      },
    });

    act(() => {
      dragSource?.dispatchEvent(dragStartEvent);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="repository-r1"]')).toBeNull();
    expect(container.querySelector('[data-testid="repository-placeholder-r1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="repository-r2"]')).toBeTruthy();

    act(() => {
      target?.dispatchEvent(dragOverEvent);
      target?.dispatchEvent(dropEvent);
    });

    expect(container.querySelector('[data-testid="repository-r1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="repository-placeholder-r1"]')).toBeNull();
    expect(container.querySelector('[data-testid="repository-r2"]')).toBeTruthy();
  });

  it("moves the empty placeholder to the preview drop position during drag", async () => {
    renderPanel({
      repositories: [
        makeRepo({ id: "r1", name: "repo-one" }),
        makeRepo({ id: "r2", name: "repo-two" }),
      ],
      selectedRepositoryId: "r1",
    });

    const dragSource = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("repo-one"));
    const target = container.querySelector('[data-testid="repository-r2"]') as HTMLElement | null;

    Object.defineProperty(target, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    const dragStartEvent = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStartEvent, "dataTransfer", {
      value: {
        effectAllowed: "move",
        setData: vi.fn(),
        setDragImage: vi.fn(),
      },
    });

    const dragOverEvent = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragOverEvent, "clientY", { value: 80 });
    Object.defineProperty(dragOverEvent, "dataTransfer", {
      value: {
        dropEffect: "move",
      },
    });

    act(() => {
      dragSource?.dispatchEvent(dragStartEvent);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      target?.dispatchEvent(dragOverEvent);
    });

    const previewOrder = Array.from(container.querySelectorAll('[data-testid^="repository-"]'))
      .map((element) => element.getAttribute("data-testid"));
    expect(previewOrder).toEqual(["repository-r2", "repository-placeholder-r1"]);
  });

  it("commits the reorder when drop lands on the empty placeholder slot", async () => {
    const onReorderRepositories = vi.fn();

    renderPanel({
      repositories: [
        makeRepo({ id: "r1", name: "repo-one" }),
        makeRepo({ id: "r2", name: "repo-two" }),
      ],
      selectedRepositoryId: "r1",
      onReorderRepositories,
    });

    const dragSource = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("repo-one"));
    const target = container.querySelector('[data-testid="repository-r2"]') as HTMLElement | null;

    Object.defineProperty(target, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    const dragStartEvent = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStartEvent, "dataTransfer", {
      value: {
        effectAllowed: "move",
        setData: vi.fn(),
        setDragImage: vi.fn(),
      },
    });

    const dragOverEvent = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragOverEvent, "clientY", { value: 80 });
    Object.defineProperty(dragOverEvent, "dataTransfer", {
      value: {
        dropEffect: "move",
      },
    });

    act(() => {
      dragSource?.dispatchEvent(dragStartEvent);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      target?.dispatchEvent(dragOverEvent);
    });

    const placeholder = container.querySelector('[data-testid="repository-placeholder-r1"]') as HTMLElement | null;
    expect(placeholder).toBeTruthy();

    const placeholderDropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(placeholderDropEvent, "dataTransfer", {
      value: {
        getData: () => "r1",
      },
    });

    act(() => {
      placeholder?.dispatchEvent(placeholderDropEvent);
    });

    expect(onReorderRepositories).toHaveBeenCalledWith("r1", "r2", "after");
  });

  it("keeps native drag stable in tauri desktop while still committing reorder on drop", async () => {
    isTauriDesktopMock.mockReturnValue(true);

    const onReorderRepositories = vi.fn();

    renderPanel({
      repositories: [
        makeRepo({ id: "r1", name: "repo-one" }),
        makeRepo({ id: "r2", name: "repo-two" }),
      ],
      selectedRepositoryId: "r1",
      onReorderRepositories,
    });

    const dragSource = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("repo-one"));
    const sourceArticle = container.querySelector('[data-testid="repository-r1"]') as HTMLElement | null;
    const target = container.querySelector('[data-testid="repository-r2"]') as HTMLElement | null;

    expect(dragSource).toBeTruthy();
    expect(sourceArticle).toBeTruthy();
    expect(target).toBeTruthy();
    expect(dragSource?.getAttribute("draggable")).toBe("false");

    Object.defineProperty(sourceArticle, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 200,
        bottom: 64,
        width: 200,
        height: 64,
        toJSON: () => ({}),
      }),
    });

    Object.defineProperty(target, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => target);

    const pointerDownEvent = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    });

    const pointerMoveEvent = new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 80,
    });

    const pointerUpEvent = new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      dragSource?.dispatchEvent(pointerDownEvent);
      window.dispatchEvent(pointerMoveEvent);
    });

    expect(container.querySelector('[data-testid="repository-r1"]')).toBeNull();
    const placeholder = container.querySelector('[data-testid="repository-placeholder-r1"]') as HTMLElement | null;
    expect(placeholder).toBeTruthy();
    expect(placeholder?.style.height).toBe("64px");
    const dragPreview = document.body.querySelector('[data-repository-drag-preview="true"]') as HTMLElement | null;
    expect(dragPreview).toBeTruthy();
    expect(dragPreview?.style.transform).toContain("translate(");
    expect(
      Array.from(container.querySelectorAll('[data-testid^="repository-"]'))
        .map((element) => element.getAttribute("data-testid")),
    ).toEqual(["repository-r2", "repository-placeholder-r1"]);

    act(() => {
      window.dispatchEvent(pointerUpEvent);
    });

    document.elementFromPoint = originalElementFromPoint;

    expect(onReorderRepositories).toHaveBeenCalledWith("r1", "r2", "after");
    expect(document.body.querySelector('[data-repository-drag-preview="true"]')).toBeNull();
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
    getGitBranchDiffSummaryMock.mockResolvedValue({
      branch: "feature-x",
      baseBranch: "main",
      insertions: 24,
      deletions: 3,
      filesChanged: 1,
      available: true,
    });

    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
      selectedWorktreeId: "r1-wt-feat",
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-review"]')?.textContent).toContain("#123");
    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-review"]')?.textContent).not.toContain("PR");
    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-diff"]')?.textContent).toContain("+24");
    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-diff"]')?.textContent).toContain("-3");
    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-review"]')?.className).toContain("h-3");
    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-review"]')?.className).toContain("translate-y-px");
    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-diff"]')?.className).toContain("h-3");
    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-review"]')?.parentElement?.parentElement?.className).toContain("pl-[20px]");
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
    getGitBranchDiffSummaryMock.mockImplementation(async (worktreeId: string) => {
      if (worktreeId === "r1-wt-feat") {
        return { branch: "feature-x", baseBranch: "main", insertions: 24, deletions: 3, filesChanged: 1, available: true };
      }
      return { branch: "main", baseBranch: "main", insertions: 0, deletions: 0, filesChanged: 0, available: true };
    });

    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
      selectedWorktreeId: "r1-wt-feat",
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="worktree-r1-wt-root-review"]')?.textContent).toContain("#9");
    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-review"]')?.textContent).toContain("#123");
    expect(container.querySelector('[data-testid="worktree-r1-wt-root-review"]')?.textContent).not.toContain("PR");
    expect(container.querySelector('[data-testid="worktree-r1-wt-root-review"]')?.getAttribute("title")).toContain("Closed");
    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-review"]')?.getAttribute("title")).toContain("Merged");
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
    getGitBranchDiffSummaryMock.mockImplementation(async (worktreeId: string) => {
      if (worktreeId === "r1-wt-feat") {
        return { branch: "feature-x", baseBranch: "main", insertions: 24, deletions: 3, filesChanged: 1, available: true };
      }
      return { branch: "main", baseBranch: "main", insertions: 0, deletions: 0, filesChanged: 0, available: true };
    });

    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
      selectedWorktreeId: "r1-wt-feat",
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-review"]')?.parentElement?.className).not.toContain("group-hover/wt:opacity-0");
    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-diff"]')?.parentElement?.className).not.toContain("group-hover/wt:opacity-0");
  });

  it("hides branch diff when summary is unavailable", async () => {
    getGitBranchDiffSummaryMock.mockResolvedValue({
      branch: "feature-x",
      baseBranch: "main",
      insertions: 0,
      deletions: 0,
      filesChanged: 0,
      available: false,
      unavailableReason: "Base branch main is not available locally or on origin",
    });

    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
      selectedWorktreeId: "r1-wt-feat",
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-diff"]')).toBeNull();
  });

  it("uses a tighter metadata indent when a worktree has no review badge", async () => {
    getGitBranchDiffSummaryMock.mockResolvedValue({
      branch: "feature-x",
      baseBranch: "main",
      insertions: 24,
      deletions: 3,
      filesChanged: 1,
      available: true,
    });

    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
      selectedWorktreeId: "r1-wt-feat",
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-review"]')).toBeNull();
    expect(container.querySelector('[data-testid="worktree-r1-wt-feat-diff"]')?.parentElement?.parentElement?.className).toContain("pl-[14px]");
  });

  it("renders root and branch status badges", async () => {
    listThreadsMock.mockImplementation(async (worktreeId: string) => {
      if (worktreeId === "r1-wt-root") {
        return [makeThread({ id: "t-root", worktreeId: "r1-wt-root", active: true })];
      }
      if (worktreeId === "r1-wt-feat") {
        return [makeThread({ id: "t-feat", worktreeId: "r1-wt-feat" })];
      }
      return [];
    });
    getThreadStatusSnapshotMock.mockImplementation(async (threadId: string) => {
      if (threadId === "t-feat") {
        return makeStatusSnapshot({ status: "waiting_approval", newestIdx: 1 });
      }
      if (threadId === "t-root") {
        return makeStatusSnapshot({ status: "running", newestIdx: null });
      }
      return makeStatusSnapshot();
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

    expect(container.querySelector('[data-testid="worktree-status-waiting_approval"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="worktree-status-running"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Running");
    expect(container.textContent).not.toContain("Idle");
  });

  it("does not render an idle status chip", async () => {
    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="worktree-status-idle"]')).toBeNull();
    expect(container.textContent).not.toContain("Idle");
  });

  it("styles the selected worktree as a flat fill without a selection ring", () => {
    renderPanel({
      repositories: [makeRepo()],
      selectedRepositoryId: "r1",
      selectedWorktreeId: "r1-wt-feat",
    });

    const featureRow = container.querySelector("[data-worktree-id='r1-wt-feat']") as HTMLElement | null;
    expect(featureRow).toBeTruthy();
    expect(featureRow?.className).toContain("bg-secondary/60");
    expect(featureRow?.className).not.toContain("ring-[0.5px]");
  });

  it("derives review-plan status from a non-latest inactive thread and forwards that thread on click", async () => {
    const onSelectWorktree = vi.fn();
    listThreadsMock.mockImplementation(async (worktreeId: string) => {
      if (worktreeId === "r1-wt-root") {
        return [makeThread({ id: "t-root", worktreeId: "r1-wt-root" })];
      }
      if (worktreeId === "r1-wt-feat") {
        return [
          makeThread({ id: "t-plan", worktreeId: "r1-wt-feat", title: "Needs review", updatedAt: "2026-01-01T00:00:00Z" }),
          makeThread({ id: "t-latest", worktreeId: "r1-wt-feat", title: "Latest idle", updatedAt: "2026-01-02T00:00:00Z" }),
        ];
      }
      return [];
    });
    getThreadStatusSnapshotMock.mockImplementation(async (threadId: string) => {
      if (threadId === "t-plan") {
        return makeStatusSnapshot({ status: "review_plan", newestIdx: 2 });
      }
      return makeStatusSnapshot();
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

    const featureRow = container.querySelector("[data-worktree-id='r1-wt-feat']") as HTMLElement | null;
    expect(featureRow).toBeTruthy();
    act(() => featureRow?.click());

    expect(onSelectWorktree).toHaveBeenCalledWith("r1", "r1-wt-feat", "t-plan");
  });
});
