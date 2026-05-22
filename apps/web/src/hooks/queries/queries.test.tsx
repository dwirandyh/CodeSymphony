import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Repository } from "@codesymphony/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";

import { useRepositories } from "./useRepositories";
import { useThreads } from "./useThreads";
import { useThreadsByWorktreeIds } from "./useThreads";
import { useThreadEvents } from "./useThreadEvents";
import { useThreadMessages } from "./useThreadMessages";
import { useThreadSnapshot } from "./useThreadSnapshot";
import { useGitStatus } from "./useGitStatus";
import { useGitBranchDiffSummary } from "./useGitBranchDiffSummary";
import { useGitDiff } from "./useGitDiff";
import { useFilesystemBrowse } from "./useFilesystemBrowse";
import { useInstalledApps } from "./useInstalledApps";
import { useFileContents } from "./useFileContents";
import { useFileIndexQuery } from "./useFileIndexQuery";
import { useWorktreeStatuses } from "./useWorktreeStatuses";
import { useRepositoryBranches } from "./useRepositoryBranches";
import { useRepositoryReviews } from "./useRepositoryReviews";
import { useClaudeModels } from "./useClaudeModels";
import { useCodexModels } from "./useCodexModels";
import { useCursorModels } from "./useCursorModels";
import { useOpencodeModels } from "./useOpencodeModels";
import { useSlashCommandsQuery } from "./useSlashCommandsQuery";
import { useBackgroundWorktreeStatusStream } from "../../pages/workspace/hooks/useBackgroundWorktreeStatusStream";
import { buildRepositoryWorktreeIndex } from "../../collections/worktrees";
import { resetFileIndexCollectionRegistryForTest } from "../../collections/fileIndex";
import { resetGitStatusCollectionRegistryForTest } from "../../collections/gitStatus";
import {
  refetchRepositoriesCollection,
  resetRepositoriesCollectionRegistryForTest,
} from "../../collections/repositories";
import { resetThreadsCollectionRegistryForTest } from "../../collections/threads";
import { queryKeys } from "../../lib/queryKeys";

vi.mock("../../lib/api", () => ({
  api: {
    listRepositories: vi.fn().mockResolvedValue([]),
    getWorkspaceBootstrap: vi.fn().mockResolvedValue({
      selection: {
        repositoryId: "r1",
        worktreeId: "wt-1",
        threadId: null,
      },
      repository: null,
      worktree: null,
      threads: [],
      threadsLoaded: true,
      thread: null,
      gitStatus: null,
      capturedAt: "2026-01-01T00:00:00.000Z",
    }),
    listThreads: vi.fn().mockResolvedValue([]),
    listEventsPage: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
    listMessagesPage: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    getThreadSnapshot: vi.fn().mockResolvedValue({ messages: [], events: [] }),
    getThreadStatusSnapshot: vi.fn().mockResolvedValue({ status: "idle", newestIdx: null }),
    getGitStatus: vi.fn().mockResolvedValue({ entries: [], branch: "main" }),
    getGitBranchDiffSummary: vi.fn().mockResolvedValue({ branch: "feature-x", baseBranch: "main", insertions: 10, deletions: 2, filesChanged: 1, available: true }),
    getGitDiff: vi.fn().mockResolvedValue({ diff: "", summary: "" }),
    browseFilesystem: vi.fn().mockResolvedValue({ entries: [] }),
    getInstalledApps: vi.fn().mockResolvedValue([]),
    listClaudeModels: vi.fn().mockResolvedValue({ models: [], fetchedAt: "2026-01-01T00:00:00.000Z" }),
    listCodexModels: vi.fn().mockResolvedValue({ models: [], fetchedAt: "2026-01-01T00:00:00.000Z" }),
    listCursorModels: vi.fn().mockResolvedValue({ models: [], fetchedAt: "2026-01-01T00:00:00.000Z" }),
    listOpencodeModels: vi.fn().mockResolvedValue({ models: [], fetchedAt: "2026-01-01T00:00:00.000Z" }),
    getFileContents: vi.fn().mockResolvedValue({ oldContent: "", newContent: "" }),
    getFileIndex: vi.fn().mockResolvedValue([]),
    getSlashCommands: vi.fn().mockResolvedValue({ commands: [], updatedAt: "2026-01-01T00:00:00.000Z" }),
    listBranches: vi.fn().mockResolvedValue([]),
    getRepositoryReviews: vi.fn().mockResolvedValue({ provider: "github", kind: "pr", available: true, reviewsByBranch: {} }),
  },
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

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(async () => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  const { resetWorkspaceStartupBootstrapForTest } = await import("../../lib/workspaceStartupBootstrap");
  resetWorkspaceStartupBootstrapForTest();
  await Promise.all([
    resetRepositoriesCollectionRegistryForTest(),
    resetGitStatusCollectionRegistryForTest(),
    resetFileIndexCollectionRegistryForTest(),
    resetThreadsCollectionRegistryForTest(),
  ]);
});

function HookRenderer({ hook, args = [] }: { hook: (...a: unknown[]) => unknown; args?: unknown[] }) {
  const result = hook(...args);
  return <div data-testid="result">{typeof result === "object" && result !== null ? "ok" : "null"}</div>;
}

function RepositoriesToggleHarness({ enabled }: { enabled: boolean }) {
  const repositories = useRepositories({ enabled });
  return (
    <div data-testid="result">
      repos:{repositories.data.length}
      ,loading:{String(repositories.isLoading)}
    </div>
  );
}

function ThreadsToggleHarness({ worktreeId }: { worktreeId: string | null }) {
  const threads = useThreads(worktreeId);
  return (
    <div data-testid="result">
      threads:{threads.data?.length ?? 0}
      ,loading:{String(threads.isLoading)}
    </div>
  );
}

function GitStatusToggleHarness({ worktreeId, enabled = true }: { worktreeId: string | null; enabled?: boolean }) {
  const gitStatus = useGitStatus(worktreeId, { enabled });
  return (
    <div data-testid="result">
      branch:{gitStatus.data?.branch ?? "none"}
      ,loading:{String(gitStatus.isLoading)}
    </div>
  );
}

function renderHook(hook: (...a: unknown[]) => unknown, args: unknown[] = []) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookRenderer hook={hook} args={args} />
      </QueryClientProvider>
    );
  });
}

function SharedThreadSnapshotHarness({ enabled = true }: { enabled?: boolean }) {
  const activeWorktreeIds = buildRepositoryWorktreeIndex(repoFixture).activeWorktreeIds;
  const threadSnapshot = useThreadsByWorktreeIds(activeWorktreeIds, { enabled });
  useWorktreeStatuses(repoFixture, enabled, threadSnapshot);
  useBackgroundWorktreeStatusStream(repoFixture, null, null, threadSnapshot);
  return <div data-testid="result">ok</div>;
}

function DeferredNonCriticalHooksHarness() {
  useInstalledApps({ enabled: false });
  useClaudeModels({ enabled: false });
  useCodexModels({ enabled: false });
  useCursorModels({ enabled: false });
  useOpencodeModels({ enabled: false });
  useRepositoryBranches("r1", { enabled: false });
  useRepositoryReviews("r1", { enabled: false });
  return <div data-testid="result">ok</div>;
}

describe("query hooks", () => {
  it("useRepositories renders", () => {
    renderHook(useRepositories as (...a: unknown[]) => unknown);
    expect(container.textContent).toBe("ok");
  });

  it("useRepositories stays inert when disabled", async () => {
    renderHook(useRepositories as (...a: unknown[]) => unknown, [{ enabled: false }]);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toBe("ok");
    expect(api.listRepositories).not.toHaveBeenCalled();
  });

  it("useRepositories starts loading when enabled after mount", async () => {
    vi.mocked(api.listRepositories).mockResolvedValueOnce(repoFixture);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RepositoriesToggleHarness enabled={false} />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("repos:0");
    expect(vi.mocked(api.listRepositories)).not.toHaveBeenCalled();

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RepositoriesToggleHarness enabled />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(api.listRepositories)).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("repos:1");
  });

  it("useRepositories renders startup bootstrap cache before the live repository refresh settles", async () => {
    const { startWorkspaceStartupBootstrap } = await import("../../lib/workspaceStartupBootstrap");
    vi.mocked(api.listRepositories).mockImplementationOnce(() => new Promise<Repository[]>(() => {}));
    vi.mocked(api.getWorkspaceBootstrap).mockResolvedValueOnce({
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

    void startWorkspaceStartupBootstrap(queryClient, {
      selection: {
        repositoryId: "r1",
        worktreeId: "wt-1",
      },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RepositoriesToggleHarness enabled />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.listRepositories).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("repos:1");
  });

  it("useRepositories refreshes the live repository list after bootstrapping from startup cache", async () => {
    const { startWorkspaceStartupBootstrap } = await import("../../lib/workspaceStartupBootstrap");
    const liveRepositories: Repository[] = [
      ...repoFixture,
      {
        id: "r2",
        name: "repo-2",
        rootPath: "/repo-2",
        defaultBranch: "main",
        setupScript: null,
        teardownScript: null,
        runScript: null,
        createdAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        worktrees: [{
          id: "wt-2",
          repositoryId: "r2",
          branch: "main",
          path: "/repo-2",
          baseBranch: "main",
          status: "active",
          branchRenamed: false,
          createdAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        }],
      },
    ];
    vi.mocked(api.getWorkspaceBootstrap).mockResolvedValueOnce({
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
    vi.mocked(api.listRepositories).mockResolvedValueOnce(liveRepositories);

    void startWorkspaceStartupBootstrap(queryClient, {
      selection: {
        repositoryId: "r1",
        worktreeId: "wt-1",
      },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RepositoriesToggleHarness enabled />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.listRepositories).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("repos:2");
  });

  it("useRepositories recovers after an initial runtime failure once the collection is refetched", async () => {
    vi.mocked(api.listRepositories)
      .mockRejectedValueOnce(new Error("Runtime API unavailable"))
      .mockResolvedValueOnce(repoFixture);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RepositoriesToggleHarness enabled />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("repos:0");

    await act(async () => {
      await refetchRepositoriesCollection(queryClient);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("repos:1");
  });

  it("useRepositories adopts late startup bootstrap data after the collection already mounted", async () => {
    const { applyWorkspaceStartupBootstrap } = await import("../../lib/workspaceStartupBootstrap");
    vi.mocked(api.listRepositories).mockResolvedValueOnce([]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RepositoriesToggleHarness enabled />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("repos:0");

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
    });

    expect(container.textContent).toContain("repos:1");
  });

  it("useRepositories adopts late startup bootstrap data after the initial live fetch fails", async () => {
    const { applyWorkspaceStartupBootstrap } = await import("../../lib/workspaceStartupBootstrap");
    vi.mocked(api.listRepositories).mockRejectedValueOnce(new Error("Runtime API unavailable"));

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RepositoriesToggleHarness enabled />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("repos:0");

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
  });

  it("useRepositories reacts to repository cache hydration even when the live collection is still empty", async () => {
    vi.mocked(api.listRepositories).mockImplementation(() => new Promise<Repository[]>(() => {}));

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RepositoriesToggleHarness enabled />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("repos:0");

    await act(async () => {
      queryClient.setQueryData(queryKeys.repositories.all, repoFixture);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("repos:1");
  });

  it("useRepositories recovers when delayed startup bootstrap arrives after the initial live fetch failure", async () => {
    const { startWorkspaceStartupBootstrap } = await import("../../lib/workspaceStartupBootstrap");
    let resolveBootstrap: ((value: Awaited<ReturnType<typeof api.getWorkspaceBootstrap>>) => void) | null = null;

    vi.mocked(api.getWorkspaceBootstrap).mockImplementationOnce(() => new Promise((resolve) => {
      resolveBootstrap = resolve;
    }));
    vi.mocked(api.listRepositories)
      .mockRejectedValueOnce(new Error("Runtime API unavailable"))
      .mockResolvedValueOnce(repoFixture);

    void startWorkspaceStartupBootstrap(queryClient, {
      selection: {
        repositoryId: "r1",
        worktreeId: "wt-1",
      },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RepositoriesToggleHarness enabled />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(api.listRepositories)).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("repos:0");

    await act(async () => {
      resolveBootstrap?.({
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
      await Promise.resolve();
    });

    expect(container.textContent).toContain("repos:1");
  });

  it("useThreads renders with worktreeId", () => {
    renderHook(useThreads as (...a: unknown[]) => unknown, ["wt-1"]);
    expect(container.textContent).toBe("ok");
  });

  it("useThreads starts loading when worktree becomes available after mount", async () => {
    vi.mocked(api.listThreads).mockResolvedValueOnce([{
      id: "t-1",
      worktreeId: "wt-1",
      title: "Boot thread",
      kind: "default",
      isAutomation: false,
      permissionProfile: "default",
      permissionMode: "default",
      mode: "default",
      titleEditedManually: false,
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      opencodeSessionId: null,
      active: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThreadsToggleHarness worktreeId={null} />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("threads:0");
    expect(vi.mocked(api.listThreads)).not.toHaveBeenCalled();

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThreadsToggleHarness worktreeId="wt-1" />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(api.listThreads)).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("threads:1");
  });

  it("useThreads reuses startup bootstrap cache before issuing thread list fetch", async () => {
    const { startWorkspaceStartupBootstrap } = await import("../../lib/workspaceStartupBootstrap");
    vi.mocked(api.getWorkspaceBootstrap).mockResolvedValueOnce({
      selection: {
        repositoryId: "r1",
        worktreeId: "wt-1",
        threadId: "t-1",
      },
      repository: repoFixture[0] ?? null,
      worktree: repoFixture[0]?.worktrees[0] ?? null,
      threads: [{
        id: "t-1",
        worktreeId: "wt-1",
        title: "Boot thread",
        kind: "default",
        isAutomation: false,
        permissionProfile: "default",
        permissionMode: "default",
        mode: "default",
        titleEditedManually: false,
        agent: "claude",
        model: "claude-sonnet-4-6",
        modelProviderId: null,
        claudeSessionId: null,
        codexSessionId: null,
        cursorSessionId: null,
        opencodeSessionId: null,
        active: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }],
      threadsLoaded: true,
      thread: null,
      gitStatus: null,
      capturedAt: "2026-01-01T00:00:00.000Z",
    });

    void startWorkspaceStartupBootstrap(queryClient, {
      selection: {
        repositoryId: "r1",
        worktreeId: "wt-1",
        threadId: "t-1",
      },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThreadsToggleHarness worktreeId="wt-1" />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.listThreads).not.toHaveBeenCalled();
    expect(container.textContent).toContain("threads:1");
  });

  it("useThreads adopts late startup bootstrap data after the collection already mounted", async () => {
    const { applyWorkspaceStartupBootstrap } = await import("../../lib/workspaceStartupBootstrap");
    vi.mocked(api.listThreads).mockResolvedValueOnce([]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThreadsToggleHarness worktreeId="wt-1" />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("threads:0");

    await act(async () => {
      applyWorkspaceStartupBootstrap(queryClient, {
        selection: {
          repositoryId: "r1",
          worktreeId: "wt-1",
          threadId: "t-1",
        },
        repository: repoFixture[0] ?? null,
        worktree: repoFixture[0]?.worktrees[0] ?? null,
        threads: [{
          id: "t-1",
          worktreeId: "wt-1",
          title: "Boot thread",
          kind: "default",
          isAutomation: false,
          permissionProfile: "default",
          permissionMode: "default",
          mode: "default",
          titleEditedManually: false,
          agent: "claude",
          model: "claude-sonnet-4-6",
          modelProviderId: null,
          claudeSessionId: null,
          codexSessionId: null,
          cursorSessionId: null,
          opencodeSessionId: null,
          active: true,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }],
        threadsLoaded: true,
        thread: null,
        gitStatus: null,
        capturedAt: "2026-01-01T00:00:00.000Z",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("threads:1");
  });

  it("useThreads settles from startup bootstrap when the selected worktree is confirmed empty", async () => {
    const { startWorkspaceStartupBootstrap } = await import("../../lib/workspaceStartupBootstrap");
    vi.mocked(api.getWorkspaceBootstrap).mockResolvedValueOnce({
      selection: {
        repositoryId: "r1",
        worktreeId: "wt-1",
        threadId: "t-1",
      },
      repository: repoFixture[0] ?? null,
      worktree: repoFixture[0]?.worktrees[0] ?? null,
      threads: [],
      threadsLoaded: true,
      thread: null,
      gitStatus: null,
      capturedAt: "2026-01-01T00:00:00.000Z",
    });

    void startWorkspaceStartupBootstrap(queryClient, {
      selection: {
        repositoryId: "r1",
        worktreeId: "wt-1",
        threadId: "t-1",
      },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThreadsToggleHarness worktreeId="wt-1" />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.listThreads).not.toHaveBeenCalled();
    expect(container.textContent).toContain("threads:0");
  });

  it("useThreads falls through to the live thread list when startup bootstrap could not resolve threads", async () => {
    const { startWorkspaceStartupBootstrap } = await import("../../lib/workspaceStartupBootstrap");
    vi.mocked(api.getWorkspaceBootstrap).mockResolvedValueOnce({
      selection: {
        repositoryId: "r1",
        worktreeId: "wt-1",
        threadId: "t-1",
      },
      repository: repoFixture[0] ?? null,
      worktree: repoFixture[0]?.worktrees[0] ?? null,
      threads: [],
      threadsLoaded: false,
      thread: null,
      gitStatus: null,
      capturedAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(api.listThreads).mockResolvedValueOnce([{
      id: "t-1",
      worktreeId: "wt-1",
      title: "Boot thread",
      kind: "default",
      isAutomation: false,
      permissionProfile: "default",
      permissionMode: "default",
      mode: "default",
      titleEditedManually: false,
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      opencodeSessionId: null,
      active: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }]);

    void startWorkspaceStartupBootstrap(queryClient, {
      selection: {
        repositoryId: "r1",
        worktreeId: "wt-1",
        threadId: "t-1",
      },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThreadsToggleHarness worktreeId="wt-1" />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.listThreads).toHaveBeenCalledTimes(1);
    expect(api.listThreads).toHaveBeenCalledWith("wt-1");
    expect(container.textContent).toContain("threads:1");
  });

  it("useThreads renders disabled (null)", () => {
    renderHook(useThreads as (...a: unknown[]) => unknown, [null]);
    expect(container.textContent).toBe("ok");
  });

  it("useThreadEvents renders with threadId", () => {
    renderHook(useThreadEvents as (...a: unknown[]) => unknown, ["t-1"]);
    expect(container.textContent).toBe("ok");
  });

  it("useThreadMessages renders with threadId", () => {
    renderHook(useThreadMessages as (...a: unknown[]) => unknown, ["t-1"]);
    expect(container.textContent).toBe("ok");
  });

  it("useThreadSnapshot renders with threadId", () => {
    renderHook(useThreadSnapshot as (...a: unknown[]) => unknown, ["t-1"]);
    expect(container.textContent).toBe("ok");
  });

  it("useGitStatus renders with worktreeId", () => {
    renderHook(useGitStatus as (...a: unknown[]) => unknown, ["wt-1"]);
    expect(container.textContent).toBe("ok");
  });

  it("useGitStatus reuses startup bootstrap cache before issuing git status fetch", async () => {
    const { startWorkspaceStartupBootstrap } = await import("../../lib/workspaceStartupBootstrap");
    vi.mocked(api.getWorkspaceBootstrap).mockResolvedValueOnce({
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
      gitStatus: {
        branch: "main",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        entries: [],
      },
      capturedAt: "2026-01-01T00:00:00.000Z",
    });

    void startWorkspaceStartupBootstrap(queryClient, {
      selection: {
        repositoryId: "r1",
        worktreeId: "wt-1",
      },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <GitStatusToggleHarness worktreeId="wt-1" />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.getGitStatus).not.toHaveBeenCalled();
    expect(container.textContent).toContain("branch:main");
  });

  it("useGitStatus adopts late startup bootstrap data after the collection already mounted", async () => {
    const { applyWorkspaceStartupBootstrap } = await import("../../lib/workspaceStartupBootstrap");
    vi.mocked(api.getGitStatus).mockResolvedValueOnce({
      branch: "stale",
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [],
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <GitStatusToggleHarness worktreeId="wt-1" />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("branch:stale");

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
        gitStatus: {
          branch: "main",
          upstream: "origin/main",
          ahead: 0,
          behind: 0,
          entries: [],
        },
        capturedAt: "2026-01-01T00:00:00.000Z",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("branch:main");
  });

  it("useGitStatus starts loading when worktree becomes available after mount", async () => {
    vi.mocked(api.getGitStatus).mockResolvedValueOnce({
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      entries: [],
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <GitStatusToggleHarness worktreeId={null} />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("branch:none");
    expect(vi.mocked(api.getGitStatus)).not.toHaveBeenCalled();

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <GitStatusToggleHarness worktreeId="wt-1" />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(api.getGitStatus)).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("branch:main");
  });

  it("useGitStatus reuses cached query data for the same worktree while live refresh is disabled", async () => {
    queryClient.setQueryData(queryKeys.worktrees.gitStatus("wt-1"), [{
      worktreeId: "wt-1",
      branch: "cached-branch",
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [{
        path: "src/cached.ts",
        status: "modified",
        insertions: 1,
        deletions: 0,
      }],
    }]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <GitStatusToggleHarness worktreeId="wt-1" enabled={false} />
        </QueryClientProvider>
      );
    });

    expect(container.textContent).toContain("branch:cached-branch");
    expect(container.textContent).toContain("loading:false");
    expect(vi.mocked(api.getGitStatus)).not.toHaveBeenCalled();

    act(() => {
      queryClient.setQueryData(queryKeys.worktrees.gitStatus("wt-1"), [{
        worktreeId: "wt-1",
        branch: "fresh-branch",
        upstream: null,
        ahead: 0,
        behind: 0,
        entries: [{
          path: "src/fresh.ts",
          status: "modified",
          insertions: 2,
          deletions: 0,
        }],
      }]);
    });

    expect(container.textContent).toContain("branch:fresh-branch");
  });

  it("useGitBranchDiffSummary renders", () => {
    renderHook(useGitBranchDiffSummary as (...a: unknown[]) => unknown, ["wt-1", "main"]);
    expect(container.textContent).toBe("ok");
  });

  it("useGitDiff renders", () => {
    renderHook(useGitDiff as (...a: unknown[]) => unknown, ["wt-1"]);
    expect(container.textContent).toBe("ok");
  });

  it("useFilesystemBrowse renders", () => {
    renderHook(useFilesystemBrowse as (...a: unknown[]) => unknown, ["/home"]);
    expect(container.textContent).toBe("ok");
  });

  it("useInstalledApps renders", () => {
    renderHook(useInstalledApps as (...a: unknown[]) => unknown);
    expect(container.textContent).toBe("ok");
  });

  it("skips deferred non-critical fetches while disabled", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DeferredNonCriticalHooksHarness />
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toBe("ok");
    expect(api.getInstalledApps).not.toHaveBeenCalled();
    expect(api.listClaudeModels).not.toHaveBeenCalled();
    expect(api.listCodexModels).not.toHaveBeenCalled();
    expect(api.listCursorModels).not.toHaveBeenCalled();
    expect(api.listOpencodeModels).not.toHaveBeenCalled();
    expect(api.listBranches).not.toHaveBeenCalled();
    expect(api.getRepositoryReviews).not.toHaveBeenCalled();
  });

  it("useFileContents renders", () => {
    renderHook(useFileContents as (...a: unknown[]) => unknown, ["wt-1", "file.ts"]);
    expect(container.textContent).toBe("ok");
  });

  it("useFileIndexQuery renders", () => {
    renderHook(useFileIndexQuery as (...a: unknown[]) => unknown, ["wt-1"]);
    expect(container.textContent).toBe("ok");
  });

  it("useSlashCommandsQuery renders", () => {
    renderHook(useSlashCommandsQuery as (...a: unknown[]) => unknown, ["wt-1"]);
    expect(container.textContent).toBe("ok");
  });

  it("useWorktreeStatuses renders", () => {
    renderHook(useWorktreeStatuses as (...a: unknown[]) => unknown, [repoFixture]);
    expect(container.textContent).toBe("ok");
  });

  it("useThreadsByWorktreeIds skips thread list fetches while disabled", async () => {
    renderHook(useThreadsByWorktreeIds as (...a: unknown[]) => unknown, [["wt-1"], { enabled: false }]);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toBe("ok");
    expect(vi.mocked(api.listThreads)).not.toHaveBeenCalled();
  });

  it("reuses one thread snapshot fetch across status and background consumers", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SharedThreadSnapshotHarness />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toBe("ok");
    expect(api.listThreads).toHaveBeenCalledTimes(1);
    expect(api.listThreads).toHaveBeenCalledWith("wt-1");
  });

  it("useRepositoryReviews renders", () => {
    renderHook(useRepositoryReviews as (...a: unknown[]) => unknown, ["r1"]);
    expect(container.textContent).toBe("ok");
  });
});
