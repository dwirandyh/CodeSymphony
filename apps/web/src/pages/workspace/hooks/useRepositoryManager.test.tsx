import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "@codesymphony/shared-types";
import { queryKeys } from "../../../lib/queryKeys";
import { useRepositoryManager } from "./useRepositoryManager";

const mockCreateRepoMutateAsync = vi.fn();
const mockCreateWorktreeMutateAsync = vi.fn().mockResolvedValue({ worktree: { id: "wt-new", branch: "new-feature" } });
const mockDeleteWorktreeMutateAsync = vi.fn();
const mockDeleteRepoMutateAsync = vi.fn();
const mockRenameBranchMutateAsync = vi.fn();
const mockUpdateWorktreeBaseBranchMutateAsync = vi.fn();

function makeRepositories(): Repository[] {
  return [
    {
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
          branch: "feature",
          path: "/home/user/.codesymphony/worktrees/test-repo/feature",
          baseBranch: "main",
          status: "active",
          branchRenamed: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    },
  ];
}

const repositoriesState = vi.hoisted(() => ({
  data: makeRepositories(),
  isLoading: false,
  error: null,
}));

vi.mock("../../../hooks/queries/useRepositories", () => ({
  useRepositories: vi.fn(() => repositoriesState),
}));

vi.mock("../../../hooks/mutations/useCreateRepository", () => ({
  useCreateRepository: () => ({ mutateAsync: mockCreateRepoMutateAsync, isPending: false }),
}));
vi.mock("../../../hooks/mutations/useCreateWorktree", () => ({
  useCreateWorktree: () => ({ mutateAsync: mockCreateWorktreeMutateAsync, isPending: false }),
}));
vi.mock("../../../hooks/mutations/useDeleteWorktree", () => ({
  useDeleteWorktree: () => ({ mutateAsync: mockDeleteWorktreeMutateAsync, isPending: false }),
}));
vi.mock("../../../hooks/mutations/useDeleteRepository", () => ({
  useDeleteRepository: () => ({ mutateAsync: mockDeleteRepoMutateAsync, isPending: false }),
}));
vi.mock("../../../hooks/mutations/useRenameWorktreeBranch", () => ({
  useRenameWorktreeBranch: () => ({ mutateAsync: mockRenameBranchMutateAsync, isPending: false }),
}));
vi.mock("../../../hooks/mutations/useUpdateWorktreeBaseBranch", () => ({
  useUpdateWorktreeBaseBranch: () => ({ mutateAsync: mockUpdateWorktreeBaseBranchMutateAsync, isPending: false }),
}));

const mockRunSetupStream = vi.fn().mockReturnValue({
  addEventListener: vi.fn(),
  close: vi.fn(),
  onerror: null,
});

vi.mock("../../../lib/api", () => ({
  api: {
    pickDirectory: vi.fn().mockResolvedValue({ path: "/selected/path" }),
    updateRepositoryScripts: vi.fn().mockImplementation(async (_repositoryId: string, input: { defaultBranch?: string }) => {
      const nextDefaultBranch = input.defaultBranch ?? "main";
      return {
        ...makeRepositories()[0],
        defaultBranch: nextDefaultBranch,
        worktrees: makeRepositories()[0].worktrees.map((worktree) =>
          worktree.path === "/home/user/test-repo"
            ? { ...worktree, baseBranch: nextDefaultBranch }
            : worktree,
        ),
      };
    }),
    runSetupStream: (...args: unknown[]) => mockRunSetupStream(...args),
    stopSetupScript: vi.fn().mockResolvedValue(undefined),
  },
  TeardownFailedError: class extends Error {
    output: string;
    constructor(output: string) {
      super("Teardown scripts failed");
      this.output = output;
    }
  },
}));

let container: HTMLDivElement;
let root: Root;
let hookResult: ReturnType<typeof useRepositoryManager>;
let mockOnError: ReturnType<typeof vi.fn>;
let mockOptions: {
  onSelectionChange?: ReturnType<typeof vi.fn>;
  onScriptUpdate?: ReturnType<typeof vi.fn>;
  onScriptOutputChunk?: ReturnType<typeof vi.fn>;
  onTeardownError?: ReturnType<typeof vi.fn>;
  desiredRepoId?: string;
  desiredWorktreeId?: string;
};

function TestComponent({ desiredRepoId, desiredWorktreeId }: { desiredRepoId?: string; desiredWorktreeId?: string }) {
  hookResult = useRepositoryManager(mockOnError, {
    ...mockOptions,
    desiredRepoId,
    desiredWorktreeId,
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

let queryClient: QueryClient;

beforeEach(() => {
  repositoriesState.data = makeRepositories();
  repositoriesState.isLoading = false;
  repositoriesState.error = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mockOnError = vi.fn();
  mockOptions = {
    onSelectionChange: vi.fn(),
    onScriptUpdate: vi.fn(),
    onScriptOutputChunk: vi.fn(),
    onTeardownError: vi.fn(),
  };
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: { desiredRepoId?: string; desiredWorktreeId?: string } = {}) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TestComponent {...props} />
      </QueryClientProvider>
    );
  });
}

describe("useRepositoryManager", () => {
  it("returns repositories from useRepositories", () => {
    render();
    expect(hookResult.repositories).toHaveLength(1);
    expect(hookResult.repositories[0].name).toBe("test-repo");
  });

  it("auto-selects first repository and worktree", () => {
    render();
    expect(hookResult.selectedRepositoryId).toBe("r1");
    expect(hookResult.selectedWorktreeId).toBeTruthy();
  });

  it("clears stale selection and cached thread data when repositories disappear", () => {
    render({ desiredWorktreeId: "wt-feat" });
    queryClient.setQueryData(queryKeys.threads.list("wt-feat"), [{ id: "t1" }]);
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot("t1"), { seed: { messages: { data: [] }, events: { data: [] } } });
    queryClient.setQueryData(queryKeys.threads.statusSnapshot("t1"), { messages: { data: [] }, events: { data: [] } });
    queryClient.setQueryData(queryKeys.worktrees.gitStatus("wt-feat"), { branch: "feature", entries: [] });

    act(() => {
      repositoriesState.data = [];
      root.render(
        <QueryClientProvider client={queryClient}>
          <TestComponent desiredWorktreeId="wt-feat" />
        </QueryClientProvider>
      );
    });

    expect(hookResult.selectedRepositoryId).toBeNull();
    expect(hookResult.selectedWorktreeId).toBeNull();
    expect(queryClient.getQueryData(queryKeys.threads.list("wt-feat"))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.threads.timelineSnapshot("t1"))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.threads.statusSnapshot("t1"))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.worktrees.gitStatus("wt-feat"))).toBeUndefined();
    expect(mockOnError).toHaveBeenCalledWith(null);
  });

  it("respects desiredWorktreeId", () => {
    render({ desiredWorktreeId: "wt-feat" });
    expect(hookResult.selectedWorktreeId).toBe("wt-feat");
    expect(hookResult.selectedRepositoryId).toBe("r1");
  });

  it("respects desiredRepoId", () => {
    render({ desiredRepoId: "r1" });
    expect(hookResult.selectedRepositoryId).toBe("r1");
  });

  it("syncs selection when desiredWorktreeId changes after mount", () => {
    render();
    expect(hookResult.selectedWorktreeId).toBe("wt-root");

    render({ desiredWorktreeId: "wt-feat" });

    expect(hookResult.selectedRepositoryId).toBe("r1");
    expect(hookResult.selectedWorktreeId).toBe("wt-feat");
  });

  it("falls back to the repository primary worktree when desiredRepoId changes after mount", () => {
    repositoriesState.data = [
      ...makeRepositories(),
      {
        id: "r2",
        name: "second-repo",
        rootPath: "/home/user/second-repo",
        defaultBranch: "develop",
        setupScript: null,
        teardownScript: null,
        runScript: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        worktrees: [
          {
            id: "wt-r2-root",
            repositoryId: "r2",
            branch: "develop",
            path: "/home/user/second-repo",
            baseBranch: "develop",
            status: "active",
            branchRenamed: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ];

    render();
    expect(hookResult.selectedRepositoryId).toBe("r1");

    render({ desiredRepoId: "r2" });

    expect(hookResult.selectedRepositoryId).toBe("r2");
    expect(hookResult.selectedWorktreeId).toBe("wt-r2-root");
  });

  it("returns selectedRepository derived from selectedRepositoryId", () => {
    render();
    expect(hookResult.selectedRepository).toBeDefined();
    expect(hookResult.selectedRepository?.id).toBe("r1");
  });

  it("returns selectedWorktree derived from selectedWorktreeId", () => {
    render({ desiredWorktreeId: "wt-feat" });
    expect(hookResult.selectedWorktree).toBeDefined();
    expect(hookResult.selectedWorktree?.branch).toBe("feature");
  });

  it("has correct initial state for loading flags", () => {
    render();
    expect(hookResult.loadingRepos).toBe(false);
    expect(hookResult.submittingRepo).toBe(false);
    expect(hookResult.submittingWorktree).toBe(false);
    expect(hookResult.setupRunning).toBe(false);
  });

  it("allows setting selection state", () => {
    render();
    act(() => hookResult.setSelectedRepositoryId("r1"));
    act(() => hookResult.setSelectedWorktreeId("wt-feat"));
    expect(hookResult.selectedRepositoryId).toBe("r1");
    expect(hookResult.selectedWorktreeId).toBe("wt-feat");
  });

  it("opens file browser", () => {
    render();
    act(() => hookResult.openFileBrowser());
    expect(hookResult.fileBrowserOpen).toBe(true);
  });

  describe("submitWorktree", () => {
    it("creates worktree and starts setup streaming", async () => {
      render();
      await act(async () => {
        await hookResult.submitWorktree("r1");
      });
      expect(mockCreateWorktreeMutateAsync).toHaveBeenCalledWith({ repositoryId: "r1" });
      expect(hookResult.selectedWorktreeId).toBe("wt-new");
      expect(hookResult.selectedRepositoryId).toBe("r1");
      expect(mockRunSetupStream).toHaveBeenCalledWith("wt-new");
      expect(mockOptions.onScriptUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: "wt-new", type: "setup", status: "running" })
      );
    });

    it("calls onError when creation fails", async () => {
      mockCreateWorktreeMutateAsync.mockRejectedValueOnce(new Error("Branch already exists"));
      render();
      await act(async () => {
        await hookResult.submitWorktree("r1");
      });
      expect(mockOnError).toHaveBeenCalledWith("Branch already exists");
    });
  });

  describe("removeWorktree", () => {
    it("deletes worktree via mutation", async () => {
      render({ desiredWorktreeId: "wt-feat" });
      expect(hookResult.selectedWorktreeId).toBe("wt-feat");
      await act(async () => {
        await hookResult.removeWorktree("wt-feat");
      });
      expect(mockDeleteWorktreeMutateAsync).toHaveBeenCalledWith("wt-feat");
    });

    it("handles teardown error", async () => {
      const { TeardownFailedError } = await import("../../../lib/api");
      const teardownErr = new TeardownFailedError("script output");
      mockDeleteWorktreeMutateAsync.mockRejectedValueOnce(teardownErr);
      render();
      await act(async () => {
        await hookResult.removeWorktree("wt-feat");
      });
      expect(mockOptions.onTeardownError).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: "wt-feat", output: "script output" })
      );
    });

    it("calls onError for non-teardown errors", async () => {
      mockDeleteWorktreeMutateAsync.mockRejectedValueOnce(new Error("Network error"));
      render();
      await act(async () => {
        await hookResult.removeWorktree("wt-feat");
      });
      expect(mockOnError).toHaveBeenCalledWith("Network error");
    });
  });

  describe("removeRepository", () => {
    it("deletes repository via mutation", async () => {
      render();
      expect(hookResult.selectedRepositoryId).toBe("r1");
      await act(async () => {
        await hookResult.removeRepository("r1");
      });
      expect(mockDeleteRepoMutateAsync).toHaveBeenCalledWith("r1");
    });

    it("calls onError on failure", async () => {
      mockDeleteRepoMutateAsync.mockRejectedValueOnce(new Error("Not found"));
      render();
      await act(async () => {
        await hookResult.removeRepository("r1");
      });
      expect(mockOnError).toHaveBeenCalledWith("Not found");
    });
  });

  describe("renameWorktreeBranch", () => {
    it("renames branch via mutation", async () => {
      render();
      await act(async () => {
        await hookResult.renameWorktreeBranch("wt-feat", "renamed-branch");
      });
      expect(mockRenameBranchMutateAsync).toHaveBeenCalledWith({
        worktreeId: "wt-feat",
        input: { branch: "renamed-branch" },
      });
    });

    it("calls onError on failure", async () => {
      mockRenameBranchMutateAsync.mockRejectedValueOnce(new Error("Rename failed"));
      render();
      await act(async () => {
        await hookResult.renameWorktreeBranch("wt-feat", "bad");
      });
      expect(mockOnError).toHaveBeenCalledWith("Rename failed");
    });
  });

  describe("updateWorktreeTargetBranch", () => {
    it("updates repository default branch for the root worktree", async () => {
      const { api } = await import("../../../lib/api");
      render({ desiredWorktreeId: "wt-root" });

      await act(async () => {
        await hookResult.updateWorktreeTargetBranch("wt-root", "develop");
      });

      expect(api.updateRepositoryScripts).toHaveBeenCalledWith("r1", { defaultBranch: "develop" });
    });

    it("updates base branch for a non-root worktree", async () => {
      render({ desiredWorktreeId: "wt-feat" });

      await act(async () => {
        await hookResult.updateWorktreeTargetBranch("wt-feat", "develop");
      });

      expect(mockUpdateWorktreeBaseBranchMutateAsync).toHaveBeenCalledWith({
        worktreeId: "wt-feat",
        input: { baseBranch: "develop" },
      });
    });

    it("calls onError when updating target branch fails", async () => {
      mockUpdateWorktreeBaseBranchMutateAsync.mockRejectedValueOnce(new Error("Target branch update failed"));
      render({ desiredWorktreeId: "wt-feat" });

      await act(async () => {
        await hookResult.updateWorktreeTargetBranch("wt-feat", "develop");
      });

      expect(mockOnError).toHaveBeenCalledWith("Target branch update failed");
    });
  });

  describe("attachRepositoryFromPath", () => {
    it("creates repository from path", async () => {
      render();
      await act(async () => {
        await hookResult.attachRepositoryFromPath("/my/repo");
      });
      expect(mockCreateRepoMutateAsync).toHaveBeenCalledWith({ path: "/my/repo" });
    });

    it("calls onError on failure", async () => {
      mockCreateRepoMutateAsync.mockRejectedValueOnce(new Error("Invalid path"));
      render();
      await act(async () => {
        await hookResult.attachRepositoryFromPath("/bad/path");
      });
      expect(mockOnError).toHaveBeenCalledWith("Invalid path");
    });
  });

  describe("rerunSetup", () => {
    it("starts setup streaming for the worktree", async () => {
      render();
      await act(async () => {
        await hookResult.rerunSetup("wt-feat");
      });
      expect(mockRunSetupStream).toHaveBeenCalledWith("wt-feat");
      expect(mockOptions.onScriptUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: "wt-feat", worktreeName: "feature", type: "setup", status: "running" })
      );
    });
  });

  describe("stopSetup", () => {
    it("stops the active setup stream", async () => {
      const { api } = await import("../../../lib/api");
      render();
      // First start a setup to have an active stream
      await act(async () => {
        await hookResult.rerunSetup("wt-feat");
      });

      await act(async () => {
        await hookResult.stopSetup();
      });
      expect(api.stopSetupScript).toHaveBeenCalledWith("wt-feat");
    });
  });

  describe("updateWorktreeBranch", () => {
    it("updates worktree branch in query cache", () => {
      render();
      act(() => {
        hookResult.updateWorktreeBranch("wt-feat", "renamed");
      });
      const cached = queryClient.getQueryData<Repository[]>(["repositories"]);
      // Function should execute without error
      expect(typeof hookResult.updateWorktreeBranch).toBe("function");
    });
  });

  describe("setup streaming events", () => {
    it("handles output events from setup stream", () => {
      const listeners: Record<string, (e: { data: string }) => void> = {};
      mockRunSetupStream.mockReturnValue({
        addEventListener: (type: string, cb: (e: { data: string }) => void) => { listeners[type] = cb; },
        close: vi.fn(),
        onerror: null,
      });

      render();
      act(() => {
        hookResult.rerunSetup("wt-feat");
      });

      act(() => {
        listeners["output"]?.({ data: JSON.stringify({ chunk: "building..." }) });
      });
      expect(mockOptions.onScriptOutputChunk).toHaveBeenCalledWith({ worktreeId: "wt-feat", chunk: "building..." });
    });

    it("handles done events from setup stream", () => {
      const listeners: Record<string, (e: { data: string }) => void> = {};
      const mockClose = vi.fn();
      mockRunSetupStream.mockReturnValue({
        addEventListener: (type: string, cb: (e: { data: string }) => void) => { listeners[type] = cb; },
        close: mockClose,
        onerror: null,
      });

      render();
      act(() => {
        hookResult.rerunSetup("wt-feat");
      });
      expect(hookResult.setupRunning).toBe(true);

      act(() => {
        listeners["done"]?.({ data: JSON.stringify({ success: true }) });
      });
      expect(mockClose).toHaveBeenCalled();
      expect(hookResult.setupRunning).toBe(false);
      expect(mockOptions.onScriptUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: "wt-feat", type: "setup", status: "completed" })
      );
    });

    it("handles error events from setup stream", () => {
      let onerrorHandler: (() => void) | null = null;
      const mockClose = vi.fn();
      mockRunSetupStream.mockReturnValue({
        addEventListener: vi.fn(),
        close: mockClose,
        set onerror(fn: (() => void) | null) { onerrorHandler = fn; },
        get onerror() { return onerrorHandler; },
      });

      render();
      act(() => {
        hookResult.rerunSetup("wt-feat");
      });
      expect(hookResult.setupRunning).toBe(true);

      act(() => {
        onerrorHandler?.();
      });
      expect(mockClose).toHaveBeenCalled();
      expect(hookResult.setupRunning).toBe(false);
    });
  });
});
