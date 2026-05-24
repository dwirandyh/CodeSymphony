import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Repository } from "@codesymphony/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refetchRepositoriesCollection, resetRepositoriesCollectionRegistryForTest } from "../../../collections/repositories";
import {
  applyWorkspaceStartupBootstrap,
  resetWorkspaceStartupBootstrapForTest,
} from "../../../lib/workspaceStartupBootstrap";
import { useRepositoryManager } from "./useRepositoryManager";

const listRepositoriesMock = vi.fn();
const measureStartupMetricSinceBootMock = vi.fn();

vi.mock("../../../lib/api", () => ({
  api: {
    listRepositories: (...args: unknown[]) => listRepositoriesMock(...args),
    updateRepositoryScripts: vi.fn(),
    runSetupStream: vi.fn(),
    stopSetupScript: vi.fn(),
  },
}));

vi.mock("../../../hooks/queries/useGitStatus", () => ({
  markWorktreeGitStatusChanged: vi.fn(),
}));

vi.mock("../../../hooks/mutations/useCreateRepository", () => ({
  useCreateRepository: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("../../../hooks/mutations/useCreateWorktree", () => ({
  useCreateWorktree: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("../../../hooks/mutations/useDeleteWorktree", () => ({
  useDeleteWorktree: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("../../../hooks/mutations/useDeleteRepository", () => ({
  useDeleteRepository: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("../../../hooks/mutations/useRenameWorktreeBranch", () => ({
  useRenameWorktreeBranch: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("../../../hooks/mutations/useUpdateWorktreeBaseBranch", () => ({
  useUpdateWorktreeBaseBranch: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("../../../lib/startupPerf", () => ({
  measureStartupMetricSinceBoot: (...args: unknown[]) => measureStartupMetricSinceBootMock(...args),
}));

const repoFixture: Repository[] = [{
  id: "r1",
  name: "repo",
  rootPath: "/repo",
  defaultBranch: "main",
  setupScript: null,
  teardownScript: null,
  runScript: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  worktrees: [{
    id: "wt-1",
    repositoryId: "r1",
    branch: "main",
    path: "/repo",
    baseBranch: "main",
    status: "active",
    branchRenamed: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }],
}];

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let hookResult: ReturnType<typeof useRepositoryManager>;
let originalConsoleError: typeof console.error;

function TestComponent() {
  hookResult = useRepositoryManager(vi.fn(), {
    desiredRepoId: "r1",
    desiredWorktreeId: "wt-1",
    repositoriesEnabled: true,
  });

  return (
    <div>
      repos:{hookResult.repositories.length}
      ,selectedRepo:{hookResult.selectedRepositoryId ?? "null"}
      ,selectedWt:{hookResult.selectedWorktreeId ?? "null"}
      ,loading:{String(hookResult.loadingRepos)}
    </div>
  );
}

describe("useRepositoryManager recovery", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    listRepositoriesMock.mockReset();
    measureStartupMetricSinceBootMock.mockReset();
    originalConsoleError = console.error;
    vi.spyOn(console, "error").mockImplementation((...args: Parameters<typeof console.error>) => {
      const [message, error] = args;
      if (
        typeof message === "string"
        && message.startsWith("[QueryCollection] Error observing query repositories")
        && error instanceof Error
        && error.message === "Runtime API unavailable"
      ) {
        return;
      }

      originalConsoleError(...args);
    });
  });

  afterEach(async () => {
    act(() => root.unmount());
    resetWorkspaceStartupBootstrapForTest();
    await resetRepositoriesCollectionRegistryForTest();
    queryClient.clear();
    container.remove();
    vi.restoreAllMocks();
  });

  it("selects requested repository and worktree after repository collection recovery", async () => {
    listRepositoriesMock
      .mockRejectedValueOnce(new Error("Runtime API unavailable"))
      .mockResolvedValueOnce(repoFixture);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TestComponent />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("selectedRepo:r1");
    expect(container.textContent).toContain("selectedWt:wt-1");

    await act(async () => {
      await refetchRepositoriesCollection(queryClient);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("repos:1");
    expect(container.textContent).toContain("selectedRepo:r1");
    expect(container.textContent).toContain("selectedWt:wt-1");
  });

  it("selects requested repository and worktree after late startup bootstrap hydration", async () => {
    listRepositoriesMock.mockResolvedValueOnce([]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TestComponent />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("repos:0");
    expect(container.textContent).toContain("selectedRepo:r1");
    expect(container.textContent).toContain("selectedWt:wt-1");

    await act(async () => {
      applyWorkspaceStartupBootstrap(queryClient, {
        selection: {
          repositoryId: "r1",
          worktreeId: "wt-1",
          threadId: null,
        },
        repository: repoFixture[0] ?? null,
        worktree: repoFixture[0]?.worktrees[0] ?? null,
        threads: [],
        threadsLoaded: true,
        thread: null,
        gitStatus: null,
        capturedAt: "2026-01-01T00:00:00.000Z",
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("repos:1");
    expect(container.textContent).toContain("selectedRepo:r1");
    expect(container.textContent).toContain("selectedWt:wt-1");
  });
});
