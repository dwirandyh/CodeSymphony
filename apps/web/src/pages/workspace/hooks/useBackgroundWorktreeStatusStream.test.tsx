import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatThread, ChatThreadSnapshot, Repository } from "@codesymphony/shared-types";
import { queryKeys } from "../../../lib/queryKeys";
import { useBackgroundWorktreeStatusStream } from "./useBackgroundWorktreeStatusStream";

const invalidateQueriesMock = vi.fn();


class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const current = this.listeners.get(type) ?? new Set<EventListener>();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  emit(type: string, payload: ChatEvent) {
    const event = { data: JSON.stringify(payload) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  open() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.();
  }

  failClosed() {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.();
  }
}

const { listThreadsMock, getThreadSnapshotMock, runtimeBaseUrlMock } = vi.hoisted(() => ({
  listThreadsMock: vi.fn(),
  getThreadSnapshotMock: vi.fn(),
  runtimeBaseUrlMock: "http://127.0.0.1:4331",
}));

vi.mock("../../../lib/api", () => ({
  api: {
    listThreads: listThreadsMock,
    getThreadSnapshot: getThreadSnapshotMock,
    get runtimeBaseUrl() {
      return runtimeBaseUrlMock;
    },
  },
}));

let originalEventSource: typeof EventSource | undefined;
let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

function makeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "t1",
    worktreeId: "wt-1",
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

function makeRepository(): Repository {
  return {
    id: "r1",
    name: "repo",
    rootPath: "/repo",
    defaultBranch: "main",
    setupScript: null,
    teardownScript: null,
    runScript: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    worktrees: [
      {
        id: "wt-1",
        repositoryId: "r1",
        branch: "main",
        path: "/repo",
        baseBranch: "main",
        status: "active",
        branchRenamed: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
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

function makeEvent(overrides: Partial<ChatEvent> & Pick<ChatEvent, "id" | "threadId" | "idx" | "type">): ChatEvent {
  return {
    id: overrides.id,
    threadId: overrides.threadId,
    idx: overrides.idx,
    type: overrides.type,
    payload: overrides.payload ?? {},
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
  };
}

function HookHarness({ repositories, selectedWorktreeId, selectedThreadId }: { repositories: Repository[]; selectedWorktreeId: string | null; selectedThreadId: string | null }) {
  useBackgroundWorktreeStatusStream(repositories, selectedWorktreeId, selectedThreadId);
  return null;
}

function renderHook(repositories: Repository[], selectedWorktreeId: string | null, selectedThreadId: string | null) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookHarness
          repositories={repositories}
          selectedWorktreeId={selectedWorktreeId}
          selectedThreadId={selectedThreadId}
        />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  invalidateQueriesMock.mockReset();
  originalEventSource = globalThis.EventSource;
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  MockEventSource.instances = [];
  listThreadsMock.mockReset();
  getThreadSnapshotMock.mockReset();
  listThreadsMock.mockResolvedValue([]);
  getThreadSnapshotMock.mockResolvedValue(makeSnapshot());
  queryClient.invalidateQueries = invalidateQueriesMock as typeof queryClient.invalidateQueries;
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

describe("useBackgroundWorktreeStatusStream", () => {
  it("excludes the selected thread from background subscriptions", async () => {
    const thread = makeThread({ id: "selected-thread", active: true });
    queryClient.setQueryData(queryKeys.threads.list("wt-1"), [thread]);
    queryClient.setQueryData(queryKeys.threads.statusSnapshot(thread.id), makeSnapshot());

    renderHook([makeRepository()], "wt-1", "selected-thread");

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("opens a stream for an active background thread", async () => {
    const repository = makeRepository();
    repository.worktrees.push({
      id: "wt-2",
      repositoryId: "r1",
      branch: "feat-2",
      path: "/repo-wt-2",
      baseBranch: "main",
      status: "active",
      branchRenamed: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const thread = makeThread({ id: "background-thread", active: true, worktreeId: "wt-2" });
    queryClient.setQueryData(queryKeys.threads.list("wt-2"), [thread]);
    queryClient.setQueryData(queryKeys.threads.statusSnapshot(thread.id), makeSnapshot());

    renderHook([repository], "wt-1", null);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toContain("/api/threads/background-thread/events/stream");
  });

  it("does not subscribe threads in the selected worktree", async () => {
    const thread = makeThread({ id: "same-worktree-thread", active: true, worktreeId: "wt-1" });
    queryClient.setQueryData(queryKeys.threads.list("wt-1"), [thread]);
    queryClient.setQueryData(queryKeys.threads.statusSnapshot(thread.id), makeSnapshot());

    renderHook([makeRepository()], "wt-1", null);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("patches thread.active=true on non-terminal events", async () => {
    const thread = makeThread({ id: "background-thread", active: true });
    queryClient.setQueryData(queryKeys.threads.list("wt-1"), [thread]);
    queryClient.setQueryData(queryKeys.threads.statusSnapshot(thread.id), makeSnapshot());

    renderHook([makeRepository()], null, null);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    queryClient.setQueryData(queryKeys.threads.list("wt-1"), [{ ...thread, active: false }]);

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit("tool.started", makeEvent({ id: "e1", threadId: thread.id, idx: 1, type: "tool.started" }));
    });

    const updated = queryClient.getQueryData<ChatThread[]>(queryKeys.threads.list("wt-1"));
    expect(updated?.[0]?.active).toBe(true);
  });

  it("patches thread.active=false on terminal events", async () => {
    const thread = makeThread({ id: "background-thread", active: true });
    queryClient.setQueryData(queryKeys.threads.list("wt-1"), [thread]);
    queryClient.setQueryData(queryKeys.threads.statusSnapshot(thread.id), makeSnapshot());

    renderHook([makeRepository()], null, null);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit("chat.completed", makeEvent({ id: "e2", threadId: thread.id, idx: 2, type: "chat.completed" }));
    });

    const updated = queryClient.getQueryData<ChatThread[]>(queryKeys.threads.list("wt-1"));
    expect(updated?.[0]?.active).toBe(false);
  });

  it.each(["chat.completed", "chat.failed"] as const)(
    "invalidates repository reviews when a background PR/MR thread receives %s",
    async (type) => {
      const thread = makeThread({
        id: "background-prmr-thread",
        active: true,
        kind: "review",
        permissionProfile: "review_git",
      });
      queryClient.setQueryData(queryKeys.threads.list("wt-1"), [thread]);
      queryClient.setQueryData(queryKeys.threads.statusSnapshot(thread.id), makeSnapshot());

      renderHook([makeRepository()], null, null);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const stream = MockEventSource.instances[0]!;
      act(() => {
        stream.emit(type, makeEvent({ id: `event-${type}`, threadId: thread.id, idx: 2, type }));
      });

      expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.repositories.reviews("r1") });
    },
  );

  it("invalidates snapshot queries on gate and plan events", async () => {
    const thread = makeThread({ id: "background-thread", active: true });
    queryClient.setQueryData(queryKeys.threads.list("wt-1"), [thread]);
    queryClient.setQueryData(queryKeys.threads.statusSnapshot(thread.id), makeSnapshot());

    renderHook([makeRepository()], null, null);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit(
        "permission.requested",
        makeEvent({
          id: "e3",
          threadId: thread.id,
          idx: 3,
          type: "permission.requested",
          payload: { requestId: "perm-1", toolName: "Bash" },
        }),
      );
      stream.emit(
        "plan.created",
        makeEvent({
          id: "e4",
          threadId: thread.id,
          idx: 4,
          type: "plan.created",
          payload: { content: "Plan", filePath: "/tmp/plan.md" },
        }),
      );
    });

    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.threads.statusSnapshot(thread.id) });
    expect(invalidateQueriesMock).toHaveBeenCalledTimes(2);
  });

  it("reconnects with afterIdx and dedupes repeated events", async () => {
    vi.useFakeTimers();
    const thread = makeThread({ id: "background-thread", active: true });
    queryClient.setQueryData(queryKeys.threads.list("wt-1"), [thread]);
    queryClient.setQueryData(queryKeys.threads.statusSnapshot(thread.id), makeSnapshot());

    renderHook([makeRepository()], null, null);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const firstStream = MockEventSource.instances[0]!;
    act(() => {
      firstStream.emit("tool.started", makeEvent({ id: "dup-event", threadId: thread.id, idx: 5, type: "tool.started" }));
    });

    const setQueryDataSpy = vi.spyOn(queryClient, "setQueryData");

    act(() => {
      firstStream.failClosed();
    });

    await act(async () => {
      vi.runOnlyPendingTimers();
    });

    const secondStream = MockEventSource.instances[1]!;
    expect(secondStream.url).toContain("afterIdx=5");

    act(() => {
      secondStream.emit("tool.started", makeEvent({ id: "dup-event", threadId: thread.id, idx: 5, type: "tool.started" }));
    });

    expect(setQueryDataSpy).not.toHaveBeenCalled();
  });
});
