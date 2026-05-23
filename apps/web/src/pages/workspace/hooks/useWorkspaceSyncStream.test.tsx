import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadStatusSnapshot, ChatTimelineSnapshot, WorkspaceSyncEvent } from "@codesymphony/shared-types";
import { queryKeys } from "../../../lib/queryKeys";
import { useWorkspaceSyncStream } from "./useWorkspaceSyncStream";

vi.mock("../../../lib/debugLog", () => ({
  debugLog: vi.fn(),
}));

const measureStartupMetricSinceBootMock = vi.fn();

vi.mock("../../../lib/startupPerf", () => ({
  measureStartupMetricSinceBoot: (...args: unknown[]) => measureStartupMetricSinceBootMock(...args),
}));

const {
  runtimeBaseUrlMock,
  getTimelineSnapshotMock,
  getThreadStatusSnapshotMock,
  startWorkspaceStartupBootstrapMock,
  refetchRepositoriesCollectionMock,
  refetchAllThreadsCollectionsMock,
  refetchThreadsCollectionMock,
  removeThreadFromCollectionMock,
  getThreadCollectionCountsMock,
  disposeThreadCollectionsMock,
  clearThreadStreamStateMock,
  requestAutomationRunsLiveRefreshMock,
  requestGitStatusLiveRefreshMock,
  requestRepositoryBranchesLiveRefreshMock,
  requestRepositoryReviewsLiveRefreshMock,
} = vi.hoisted(() => ({
  runtimeBaseUrlMock: "http://127.0.0.1:4331",
  getTimelineSnapshotMock: vi.fn(),
  getThreadStatusSnapshotMock: vi.fn(),
  startWorkspaceStartupBootstrapMock: vi.fn(),
  refetchRepositoriesCollectionMock: vi.fn(),
  refetchAllThreadsCollectionsMock: vi.fn(),
  refetchThreadsCollectionMock: vi.fn(),
  removeThreadFromCollectionMock: vi.fn(),
  getThreadCollectionCountsMock: vi.fn(),
  disposeThreadCollectionsMock: vi.fn(),
  clearThreadStreamStateMock: vi.fn(),
  requestAutomationRunsLiveRefreshMock: vi.fn(),
  requestGitStatusLiveRefreshMock: vi.fn(),
  requestRepositoryBranchesLiveRefreshMock: vi.fn(),
  requestRepositoryReviewsLiveRefreshMock: vi.fn(),
}));

vi.mock("../../../lib/api", () => ({
  api: {
    getTimelineSnapshot: getTimelineSnapshotMock,
    getThreadStatusSnapshot: getThreadStatusSnapshotMock,
    get runtimeBaseUrl() {
      return runtimeBaseUrlMock;
    },
  },
}));

vi.mock("../../../lib/workspaceStartupBootstrap", () => ({
  startWorkspaceStartupBootstrap: (...args: unknown[]) => startWorkspaceStartupBootstrapMock(...args),
}));

vi.mock("../../../collections/repositories", () => ({
  refetchRepositoriesCollection: refetchRepositoriesCollectionMock,
}));

vi.mock("../../../collections/threads", () => ({
  refetchAllThreadsCollections: refetchAllThreadsCollectionsMock,
  refetchThreadsCollection: refetchThreadsCollectionMock,
  removeThreadFromCollection: removeThreadFromCollectionMock,
}));

vi.mock("../../../collections/threadCollections", () => ({
  getThreadCollectionCounts: getThreadCollectionCountsMock,
  disposeThreadCollections: disposeThreadCollectionsMock,
}));

vi.mock("../../../collections/threadStreamState", () => ({
  clearThreadStreamState: clearThreadStreamStateMock,
}));

vi.mock("../../../hooks/queries/useAutomationRuns", () => ({
  requestAutomationRunsLiveRefresh: requestAutomationRunsLiveRefreshMock,
}));

vi.mock("../../../hooks/queries/useGitStatus", () => ({
  requestGitStatusLiveRefresh: requestGitStatusLiveRefreshMock,
}));

vi.mock("../../../hooks/queries/useRepositoryBranches", () => ({
  requestRepositoryBranchesLiveRefresh: requestRepositoryBranchesLiveRefreshMock,
}));

vi.mock("../../../hooks/queries/useRepositoryReviews", () => ({
  requestRepositoryReviewsLiveRefresh: requestRepositoryReviewsLiveRefreshMock,
}));

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" } as CloseEvent);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  fail() {
    this.readyState = MockWebSocket.CLOSED;
    this.onerror?.();
    this.onclose?.({ code: 1006, reason: "" } as CloseEvent);
  }

  emit(payload: WorkspaceSyncEvent) {
    this.onmessage?.({
      data: JSON.stringify({
        type: "workspace_sync",
        event: payload,
      }),
    } as MessageEvent<string>);
  }
}

let originalWebSocket: typeof WebSocket | undefined;
let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const invalidateQueriesMock = vi.fn();
const removeQueriesMock = vi.fn();

function makeTimelineSnapshot(): ChatTimelineSnapshot {
  return {
    timelineItems: [],
    summary: {
      oldestRenderableKey: null,
      oldestRenderableKind: null,
      oldestRenderableMessageId: null,
      oldestRenderableHydrationPending: false,
      headIdentityStable: true,
    },
    newestSeq: 2,
    newestIdx: 3,
    messages: [],
    events: [],
  };
}

function makeStatusSnapshot(): ChatThreadStatusSnapshot {
  return {
    status: "idle",
    newestIdx: 3,
  };
}

function HookHarness() {
  useWorkspaceSyncStream();
  return null;
}

function renderHook() {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookHarness />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  invalidateQueriesMock.mockReset();
  invalidateQueriesMock.mockResolvedValue(undefined);
  queryClient.invalidateQueries = invalidateQueriesMock as typeof queryClient.invalidateQueries;
  removeQueriesMock.mockReset();
  queryClient.removeQueries = removeQueriesMock as typeof queryClient.removeQueries;

  getTimelineSnapshotMock.mockReset();
  getTimelineSnapshotMock.mockResolvedValue(makeTimelineSnapshot());
  getThreadStatusSnapshotMock.mockReset();
  getThreadStatusSnapshotMock.mockResolvedValue(makeStatusSnapshot());
  startWorkspaceStartupBootstrapMock.mockReset();
  startWorkspaceStartupBootstrapMock.mockResolvedValue(null);
  refetchRepositoriesCollectionMock.mockReset();
  refetchRepositoriesCollectionMock.mockResolvedValue(undefined);
  refetchAllThreadsCollectionsMock.mockReset();
  refetchAllThreadsCollectionsMock.mockResolvedValue([]);
  refetchThreadsCollectionMock.mockReset();
  refetchThreadsCollectionMock.mockResolvedValue([]);
  removeThreadFromCollectionMock.mockReset();
  getThreadCollectionCountsMock.mockReset();
  getThreadCollectionCountsMock.mockReturnValue(null);
  disposeThreadCollectionsMock.mockReset();
  clearThreadStreamStateMock.mockReset();
  requestAutomationRunsLiveRefreshMock.mockReset();
  requestGitStatusLiveRefreshMock.mockReset();
  requestRepositoryBranchesLiveRefreshMock.mockReset();
  requestRepositoryReviewsLiveRefreshMock.mockReset();
  measureStartupMetricSinceBootMock.mockReset();

  originalWebSocket = globalThis.WebSocket;
  vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  MockWebSocket.instances = [];
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  if (originalWebSocket) {
    globalThis.WebSocket = originalWebSocket;
  }
  vi.useRealTimers();
});

describe("useWorkspaceSyncStream", () => {
  it("retries startup bootstrap before revalidating collections when live socket opens", async () => {
    renderHook();

    act(() => {
      MockWebSocket.instances[0]!.open();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(startWorkspaceStartupBootstrapMock).toHaveBeenCalledWith(queryClient);
    expect(startWorkspaceStartupBootstrapMock.mock.invocationCallOrder[0]).toBeLessThan(
      refetchRepositoriesCollectionMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(startWorkspaceStartupBootstrapMock.mock.invocationCallOrder[0]).toBeLessThan(
      refetchAllThreadsCollectionsMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not block collection revalidation on a slow startup bootstrap retry", async () => {
    startWorkspaceStartupBootstrapMock.mockImplementationOnce(() => new Promise(() => {}));

    renderHook();

    act(() => {
      MockWebSocket.instances[0]!.open();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(startWorkspaceStartupBootstrapMock).toHaveBeenCalledWith(queryClient);
    expect(refetchRepositoriesCollectionMock).toHaveBeenCalledWith(queryClient);
    expect(refetchAllThreadsCollectionsMock).toHaveBeenCalledWith(queryClient);
  });

  it("reconnects and revalidates workspace state after the workspace live websocket closes", async () => {
    renderHook();

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]!.url).toBe("ws://127.0.0.1:4331/api/workspace/live/ws");
    act(() => {
      MockWebSocket.instances[0]!.open();
    });

    expect(measureStartupMetricSinceBootMock).toHaveBeenCalledWith("startup.live_connected_ms", {
      source: "workspace-sync-socket",
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(MockWebSocket.instances[0]!.sentMessages).toContain(JSON.stringify({
      type: "subscribe",
      subscriptions: [{ type: "workspace_sync" }],
    }));

    expect(refetchRepositoriesCollectionMock).toHaveBeenCalledTimes(1);
    expect(refetchAllThreadsCollectionsMock).toHaveBeenCalledTimes(1);
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ["automations"] });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ["threads"] });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ["worktrees"] });

    act(() => {
      MockWebSocket.instances[0]!.fail();
      vi.advanceTimersByTime(1_000);
    });

    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => {
      MockWebSocket.instances[1]!.open();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(refetchRepositoriesCollectionMock).toHaveBeenCalledTimes(2);
    expect(refetchAllThreadsCollectionsMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes cached thread snapshots when a known thread is updated", async () => {
    getThreadCollectionCountsMock.mockReturnValue({
      messagesCount: 3,
      eventsCount: 8,
    });

    renderHook();

    act(() => {
      MockWebSocket.instances[0]!.open();
    });

    act(() => {
      MockWebSocket.instances[0]!.emit({
        id: "ws-1",
        type: "thread.updated",
        repositoryId: "repo-1",
        worktreeId: "wt-1",
        threadId: "thread-1",
        createdAt: "2026-01-01T00:00:00Z",
      });
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refetchThreadsCollectionMock).toHaveBeenCalledWith(queryClient, "wt-1");
    expect(getTimelineSnapshotMock).toHaveBeenCalledWith("thread-1");
    expect(getThreadStatusSnapshotMock).toHaveBeenCalledWith("thread-1");
    expect(queryClient.getQueryData(queryKeys.threads.timelineSnapshot("thread-1"))).toEqual(makeTimelineSnapshot());
    expect(queryClient.getQueryData(queryKeys.threads.statusSnapshot("thread-1"))).toEqual(makeStatusSnapshot());
  });

  it("keeps automation run updates on coarse sync responsibilities only", async () => {
    renderHook();

    act(() => {
      MockWebSocket.instances[0]!.open();
    });

    await act(async () => {
      await Promise.resolve();
    });

    invalidateQueriesMock.mockClear();
    removeQueriesMock.mockClear();

    act(() => {
      MockWebSocket.instances[0]!.emit({
        id: "ws-automation-run",
        type: "automation.run.updated",
        automationId: "automation-1",
        repositoryId: null,
        worktreeId: null,
        threadId: null,
        createdAt: "2026-01-01T00:00:00Z",
      });
    });

    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.automations.lists });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.automations.detail("automation-1") });
    expect(requestAutomationRunsLiveRefreshMock).not.toHaveBeenCalled();
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.automations.runs("automation-1") });
    expect(removeQueriesMock).not.toHaveBeenCalled();

    invalidateQueriesMock.mockClear();
    removeQueriesMock.mockClear();

    act(() => {
      MockWebSocket.instances[0]!.emit({
        id: "ws-automation-delete",
        type: "automation.deleted",
        automationId: "automation-1",
        repositoryId: null,
        worktreeId: null,
        threadId: null,
        createdAt: "2026-01-01T00:00:01Z",
      });
    });

    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.automations.lists });
    expect(removeQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.automations.detail("automation-1") });
    expect(removeQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.automations.runs("automation-1") });
    expect(removeQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.automations.versions("automation-1") });
  });

  it("keeps worktree sync events focused on non-live-owned queries", async () => {
    renderHook();

    act(() => {
      MockWebSocket.instances[0]!.open();
    });

    await act(async () => {
      await Promise.resolve();
    });

    invalidateQueriesMock.mockClear();

    act(() => {
      MockWebSocket.instances[0]!.emit({
        id: "ws-files-update",
        type: "worktree.files.updated",
        repositoryId: "repo-1",
        worktreeId: "wt-1",
        threadId: null,
        createdAt: "2026-01-01T00:00:00Z",
      });
    });

    expect(requestGitStatusLiveRefreshMock).not.toHaveBeenCalled();
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.worktrees.gitStatus("wt-1") });
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.worktrees.gitDiffScope("wt-1") });
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: ["worktrees", "wt-1", "gitBranchDiffSummary"] });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.worktrees.fileIndex("wt-1") });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.worktrees.fileTreeScope("wt-1") });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ["worktrees", "wt-1", "slashCommands"] });
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.repositories.reviews("repo-1") });

    invalidateQueriesMock.mockClear();
    requestGitStatusLiveRefreshMock.mockClear();

    act(() => {
      MockWebSocket.instances[0]!.emit({
        id: "ws-git-update",
        type: "worktree.git.updated",
        repositoryId: "repo-1",
        worktreeId: "wt-1",
        threadId: null,
        createdAt: "2026-01-01T00:00:01Z",
      });
    });

    expect(requestGitStatusLiveRefreshMock).not.toHaveBeenCalled();
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.worktrees.gitDiffScope("wt-1") });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: queryKeys.worktrees.gitBranchDiffSummary("wt-1", "__all__"),
      exact: false,
    });
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.worktrees.fileIndex("wt-1") });
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.worktrees.fileTreeScope("wt-1") });
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.repositories.reviews("repo-1") });
  });

  it("does not refresh repository live resources from repository metadata sync events", async () => {
    renderHook();

    act(() => {
      MockWebSocket.instances[0]!.open();
    });

    await act(async () => {
      await Promise.resolve();
    });

    requestRepositoryBranchesLiveRefreshMock.mockClear();
    requestRepositoryReviewsLiveRefreshMock.mockClear();

    act(() => {
      MockWebSocket.instances[0]!.emit({
        id: "ws-repo-update",
        type: "repository.updated",
        repositoryId: "repo-1",
        worktreeId: null,
        threadId: null,
        createdAt: "2026-01-01T00:00:02Z",
      });
    });

    expect(refetchRepositoriesCollectionMock).toHaveBeenCalledWith(queryClient);
    expect(requestRepositoryBranchesLiveRefreshMock).not.toHaveBeenCalled();
    expect(requestRepositoryReviewsLiveRefreshMock).not.toHaveBeenCalled();
  });
});
