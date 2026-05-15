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
import { useRepositoryReviews } from "./useRepositoryReviews";
import { useSlashCommandsQuery } from "./useSlashCommandsQuery";
import { useBackgroundWorktreeStatusStream } from "../../pages/workspace/hooks/useBackgroundWorktreeStatusStream";
import { buildRepositoryWorktreeIndex } from "../../collections/worktrees";
import { resetFileIndexCollectionRegistryForTest } from "../../collections/fileIndex";
import { resetGitStatusCollectionRegistryForTest } from "../../collections/gitStatus";
import { resetRepositoriesCollectionRegistryForTest } from "../../collections/repositories";
import { resetThreadsCollectionRegistryForTest } from "../../collections/threads";

vi.mock("../../lib/api", () => ({
  api: {
    listRepositories: vi.fn().mockResolvedValue([]),
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
    getFileContents: vi.fn().mockResolvedValue({ oldContent: "", newContent: "" }),
    getFileIndex: vi.fn().mockResolvedValue([]),
    getSlashCommands: vi.fn().mockResolvedValue({ commands: [], updatedAt: "2026-01-01T00:00:00.000Z" }),
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

describe("query hooks", () => {
  it("useRepositories renders", () => {
    renderHook(useRepositories);
    expect(container.textContent).toBe("ok");
  });

  it("useThreads renders with worktreeId", () => {
    renderHook(useThreads as (...a: unknown[]) => unknown, ["wt-1"]);
    expect(container.textContent).toBe("ok");
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
    renderHook(useInstalledApps);
    expect(container.textContent).toBe("ok");
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
