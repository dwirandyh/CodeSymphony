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

const {
  runtimeBaseUrlMock,
  getTimelineSnapshotMock,
  getThreadStatusSnapshotMock,
  refetchRepositoriesCollectionMock,
  refetchAllThreadsCollectionsMock,
  refetchThreadsCollectionMock,
  removeThreadFromCollectionMock,
  getThreadCollectionCountsMock,
  disposeThreadCollectionsMock,
  clearThreadStreamStateMock,
} = vi.hoisted(() => ({
  runtimeBaseUrlMock: "http://127.0.0.1:4331",
  getTimelineSnapshotMock: vi.fn(),
  getThreadStatusSnapshotMock: vi.fn(),
  refetchRepositoriesCollectionMock: vi.fn(),
  refetchAllThreadsCollectionsMock: vi.fn(),
  refetchThreadsCollectionMock: vi.fn(),
  removeThreadFromCollectionMock: vi.fn(),
  getThreadCollectionCountsMock: vi.fn(),
  disposeThreadCollectionsMock: vi.fn(),
  clearThreadStreamStateMock: vi.fn(),
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

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  open() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.();
  }

  fail() {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.();
  }

  emit(payload: WorkspaceSyncEvent) {
    this.onmessage?.({
      data: JSON.stringify(payload),
    } as MessageEvent<string>);
  }
}

let originalEventSource: typeof EventSource | undefined;
let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const invalidateQueriesMock = vi.fn();

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

  getTimelineSnapshotMock.mockReset();
  getTimelineSnapshotMock.mockResolvedValue(makeTimelineSnapshot());
  getThreadStatusSnapshotMock.mockReset();
  getThreadStatusSnapshotMock.mockResolvedValue(makeStatusSnapshot());
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

  originalEventSource = globalThis.EventSource;
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  MockEventSource.instances = [];
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  if (originalEventSource) {
    globalThis.EventSource = originalEventSource;
  }
  vi.useRealTimers();
});

describe("useWorkspaceSyncStream", () => {
  it("reconnects and revalidates workspace state after the SSE stream closes", async () => {
    renderHook();

    expect(MockEventSource.instances).toHaveLength(1);
    act(() => {
      MockEventSource.instances[0]!.open();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(refetchRepositoriesCollectionMock).toHaveBeenCalledTimes(1);
    expect(refetchAllThreadsCollectionsMock).toHaveBeenCalledTimes(1);
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ["threads"] });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ["worktrees"] });

    act(() => {
      MockEventSource.instances[0]!.fail();
      vi.advanceTimersByTime(1_000);
    });

    expect(MockEventSource.instances).toHaveLength(2);

    act(() => {
      MockEventSource.instances[1]!.open();
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
      MockEventSource.instances[0]!.open();
    });

    act(() => {
      MockEventSource.instances[0]!.emit({
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
});
