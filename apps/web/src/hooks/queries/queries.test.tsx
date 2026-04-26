import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRepositories } from "./useRepositories";
import { useThreads } from "./useThreads";
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

const repoFixture = [{
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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

  it("useRepositoryReviews renders", () => {
    renderHook(useRepositoryReviews as (...a: unknown[]) => unknown, ["r1"]);
    expect(container.textContent).toBe("ok");
  });
});
