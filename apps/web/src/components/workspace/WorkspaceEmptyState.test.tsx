import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { WorkspaceEmptyState } from "./WorkspaceEmptyState";

vi.mock("../../hooks/queries/useInstalledApps", () => ({
  useInstalledApps: vi.fn().mockReturnValue({
    data: [
      { id: "cursor", name: "Cursor", bundleId: "com.cursor", path: "/Applications/Cursor.app", iconUrl: "/api/system/installed-apps/cursor/icon" },
      { id: "finder", name: "Finder", bundleId: "com.apple.finder", path: "/System/Library/CoreServices/Finder.app", iconUrl: "/api/system/installed-apps/finder/icon" },
    ],
    isLoading: false,
  }),
}));

vi.mock("../../lib/api", () => ({
  api: {
    openInApp: vi.fn().mockResolvedValue(undefined),
    runtimeBaseUrl: "http://127.0.0.1:4331",
  },
}));

function findButtonByText(container: HTMLDivElement, label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    button.textContent?.includes(label)
  ) ?? null;
}

describe("WorkspaceEmptyState", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => {
      flushSync(() => {
        root.unmount();
      });
    });
    container.remove();
    localStorage.clear();
    vi.clearAllMocks();
  });

  function renderState(overrides?: Partial<Parameters<typeof WorkspaceEmptyState>[0]>) {
    const props: Parameters<typeof WorkspaceEmptyState>[0] = {
      repositoryName: "codesymphony",
      worktreeBranch: "feature/landing",
      worktreePath: "/tmp/codesymphony",
      hasWorktree: true,
      worktreeReady: true,
      preparingThread: false,
      gitChangeCount: 3,
      recentFilePaths: ["apps/web/src/pages/WorkspacePage.tsx", "packages/shared-types/src/index.ts"],
      reviewKind: "pr",
      reviewRef: null,
      canCreateThread: true,
      canOpenFiles: true,
      canCreateTerminal: true,
      canOpenCommitChanges: true,
      showRevealRepositoriesAction: true,
      onCreateThread: vi.fn(),
      onOpenFilePicker: vi.fn(),
      onCreateTerminal: vi.fn(),
      onOpenCommitChanges: vi.fn(),
      onOpenPullRequest: vi.fn(),
      onRevealRepositories: vi.fn(),
      onOpenRecentFile: vi.fn(),
    };

    act(() => {
      flushSync(() => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <WorkspaceEmptyState {...props} {...overrides} />
          </QueryClientProvider>
        );
      });
    });

    return props;
  }

  it("renders the compact Superset-style action list", () => {
    renderState();

    expect(container.querySelector("[data-testid='workspace-empty-state']")).not.toBeNull();
    expect(container.textContent).toContain("New Terminal");
    expect(container.textContent).toContain("New Thread");
    expect(container.textContent).toContain("Search Files");
    expect(container.textContent).toContain("Open in Cursor");
    expect(container.textContent).toContain("Commit Changes");
    expect(container.textContent).toContain("Show repositories");
  });

  it("routes primary, app, and secondary actions", async () => {
    const props = renderState();
    const newThreadButton = findButtonByText(container, "New Thread");
    const openFileButton = findButtonByText(container, "Search Files");
    const terminalButton = findButtonByText(container, "New Terminal");
    const openInAppButton = findButtonByText(container, "Open in Cursor");
    const reviewButton = findButtonByText(container, "Commit Changes");
    const revealButton = container.querySelector<HTMLButtonElement>("[data-testid='workspace-empty-state-show-repositories']");

    if (!newThreadButton || !openFileButton || !terminalButton || !openInAppButton || !reviewButton || !revealButton) {
      throw new Error("Expected workspace empty state buttons were not found");
    }

    await act(async () => {
      flushSync(() => {
        newThreadButton.click();
        openFileButton.click();
        terminalButton.click();
        openInAppButton.click();
        reviewButton.click();
        revealButton.click();
      });
      await Promise.resolve();
    });

    expect(props.onCreateThread).toHaveBeenCalledTimes(1);
    expect(props.onOpenFilePicker).toHaveBeenCalledTimes(1);
    expect(props.onCreateTerminal).toHaveBeenCalledTimes(1);
    expect(api.openInApp).toHaveBeenCalledWith({ appId: "cursor", targetPath: "/tmp/codesymphony" });
    expect(props.onOpenCommitChanges).toHaveBeenCalledTimes(1);
    expect(props.onRevealRepositories).toHaveBeenCalledTimes(1);
  });

  it("switches the git action to open the active pull request", () => {
    const props = renderState({
      reviewRef: {
        number: 42,
        display: "#42",
        url: "https://example.com/pull/42",
        state: "open",
      },
    });

    expect(container.textContent).toContain("Open Pull Request");
    expect(container.textContent).not.toContain("Commit Changes");

    const openPullRequestButton = findButtonByText(container, "Open Pull Request");
    if (!openPullRequestButton) {
      throw new Error("Open Pull Request button was not found");
    }

    act(() => {
      flushSync(() => {
        openPullRequestButton.click();
      });
    });

    expect(props.onOpenPullRequest).toHaveBeenCalledTimes(1);
    expect(props.onOpenCommitChanges).not.toHaveBeenCalled();
  });

  it("hides the git action when there is no open review and no uncommitted changes", () => {
    renderState({
      gitChangeCount: 0,
      canOpenCommitChanges: false,
    });

    expect(container.textContent).not.toContain("Commit Changes");
    expect(container.textContent).not.toContain("Open Pull Request");
    expect(container.textContent).not.toContain("Open Merge Request");
  });

  it("disables workspace actions when no worktree is selected", () => {
    renderState({
      repositoryName: null,
      worktreeBranch: null,
      worktreePath: null,
      hasWorktree: false,
      worktreeReady: false,
      canCreateThread: false,
      canOpenFiles: false,
      canCreateTerminal: false,
      canOpenCommitChanges: false,
      showRevealRepositoriesAction: false,
      recentFilePaths: [],
    });

    const actionButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-testid^='workspace-empty-state-action-']"),
    );

    expect(actionButtons).toHaveLength(4);
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
    expect(container.textContent).not.toContain("Show repositories");
  });
});
