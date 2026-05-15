import { StrictMode, useRef, useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatEvent,
  ChatThread,
  ChatTimelineSnapshot,
} from "@codesymphony/shared-types";
import {
  getThreadEventsCollection,
  getThreadMessagesCollection,
  resetThreadCollectionsForTest,
} from "../../../../collections/threadCollections";
import { resetThreadStreamStateRegistryForTest } from "../../../../collections/threadStreamState";
import { queryKeys } from "../../../../lib/queryKeys";
import { useThreadEventStream } from "./useThreadEventStream";

const invalidateQueriesMock = vi.fn();
const cancelQueriesMock = vi.fn();


vi.mock("../../../../lib/logService", () => ({
  logService: {
    log: vi.fn(),
  },
}));

vi.mock("../../../../lib/debugLog", () => ({
  debugLog: vi.fn(),
}));

vi.mock("../../../../lib/renderDebug", () => ({
  pushRenderDebug: vi.fn(),
}));

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
}

const { runtimeBaseUrlMock, getThreadStatusSnapshotMock, getTimelineSnapshotMock } = vi.hoisted(() => ({
  runtimeBaseUrlMock: "http://127.0.0.1:4331",
  getThreadStatusSnapshotMock: vi.fn(),
  getTimelineSnapshotMock: vi.fn(),
}));

vi.mock("../../../../lib/api", () => ({
  api: {
    getThreadStatusSnapshot: getThreadStatusSnapshotMock,
    getTimelineSnapshot: getTimelineSnapshotMock,
    get runtimeBaseUrl() {
      return runtimeBaseUrlMock;
    },
  },
}));

let originalEventSource: typeof EventSource | undefined;
let originalRequestAnimationFrame: typeof requestAnimationFrame | undefined;
let originalCancelAnimationFrame: typeof cancelAnimationFrame | undefined;
let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let latestThreads: ChatThread[] = [];

function makeSnapshot(events: ChatEvent[] = []): ChatTimelineSnapshot {
  return {
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

let latestWaitingAssistant: { threadId: string; afterIdx: number } | null = null;

function HookHarness({
  selectedThreadId,
  repositoryId = null,
  selectedThreadIsPrMr = false,
  initialWaitingAssistant = null,
  initialThreads = [],
}: {
  selectedThreadId: string | null;
  repositoryId?: string | null;
  selectedThreadIsPrMr?: boolean;
  initialWaitingAssistant?: { threadId: string; afterIdx: number } | null;
  initialThreads?: ChatThread[];
}) {
  const [threads, setThreads] = useState<ChatThread[]>(initialThreads);
  const [waitingAssistant, setWaitingAssistant] = useState<{ threadId: string; afterIdx: number } | null>(initialWaitingAssistant);
  const [stoppingThreadId, setStoppingThreadId] = useState<string | null>(null);
  const [stopRequestedThreadId, setStopRequestedThreadId] = useState<string | null>(null);

  latestWaitingAssistant = waitingAssistant;
  latestThreads = threads;

  void stoppingThreadId;
  void stopRequestedThreadId;

  const streamingMessageIdsRef = useRef(new Set<string>());
  const stickyRawFallbackMessageIdsRef = useRef(new Set<string>());
  const renderDecisionByMessageIdRef = useRef(new Map<string, string>());
  const locallyDeletedThreadIdsRef = useRef<Set<string>>(new Set());
  const activeThreadIdRef = useRef<string | null>(selectedThreadId);
  const waitingAssistantRef = useRef<{ threadId: string; afterIdx: number } | null>(waitingAssistant);
  activeThreadIdRef.current = selectedThreadId;
  waitingAssistantRef.current = waitingAssistant;

  useThreadEventStream({
    selectedThreadId,
    selectedWorktreeId: "wt-1",
    repositoryId,
    selectedThreadIsPrMr,
    locallyDeletedThreadIdsRef,
    activeThreadIdRef,
    waitingAssistantRef,
    setThreads,
    setWaitingAssistant,
    setStoppingThreadId,
    setStopRequestedThreadId,
    streamingMessageIdsRef,
    stickyRawFallbackMessageIdsRef,
    renderDecisionByMessageIdRef,
    onError: vi.fn(),
  });

  return null;
}

function renderHook(
  selectedThreadId: string | null,
  options?: {
    repositoryId?: string | null;
    selectedThreadIsPrMr?: boolean;
    initialWaitingAssistant?: { threadId: string; afterIdx: number } | null;
    initialThreads?: ChatThread[];
  },
) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookHarness
          selectedThreadId={selectedThreadId}
          repositoryId={options?.repositoryId}
          selectedThreadIsPrMr={options?.selectedThreadIsPrMr}
          initialWaitingAssistant={options?.initialWaitingAssistant}
          initialThreads={options?.initialThreads}
        />
      </QueryClientProvider>,
    );
  });
}

function renderHookInStrictMode(
  selectedThreadId: string | null,
  options?: {
    repositoryId?: string | null;
    selectedThreadIsPrMr?: boolean;
    initialWaitingAssistant?: { threadId: string; afterIdx: number } | null;
    initialThreads?: ChatThread[];
  },
) {
  act(() => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <HookHarness
            selectedThreadId={selectedThreadId}
            repositoryId={options?.repositoryId}
            selectedThreadIsPrMr={options?.selectedThreadIsPrMr}
            initialWaitingAssistant={options?.initialWaitingAssistant}
            initialThreads={options?.initialThreads}
          />
        </QueryClientProvider>
      </StrictMode>,
    );
  });
}

beforeEach(() => {
  resetThreadCollectionsForTest();
  resetThreadStreamStateRegistryForTest();
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latestThreads = [];
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  latestWaitingAssistant = null;
  invalidateQueriesMock.mockReset();
  cancelQueriesMock.mockReset();
  cancelQueriesMock.mockResolvedValue(undefined);
  getThreadStatusSnapshotMock.mockReset();
  getThreadStatusSnapshotMock.mockResolvedValue({ status: "idle", newestIdx: null });
  getTimelineSnapshotMock.mockReset();
  getTimelineSnapshotMock.mockResolvedValue(makeSnapshot());
  queryClient.invalidateQueries = invalidateQueriesMock as typeof queryClient.invalidateQueries;
  queryClient.cancelQueries = cancelQueriesMock as typeof queryClient.cancelQueries;

  originalEventSource = globalThis.EventSource;
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  MockEventSource.instances = [];

  originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  vi.stubGlobal("requestAnimationFrame", ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  resetThreadCollectionsForTest();
  resetThreadStreamStateRegistryForTest();
  vi.useRealTimers();
  if (originalEventSource) {
    globalThis.EventSource = originalEventSource;
  }
  if (originalRequestAnimationFrame) {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
  if (originalCancelAnimationFrame) {
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

describe("useThreadEventStream", () => {
  it("does not hit a render loop while bootstrapping with no selected thread", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      renderHookInStrictMode(null);

      await act(async () => {
        await Promise.resolve();
      });

      expect(
        consoleErrorSpy.mock.calls.some((call) =>
          call.some(
            (arg) => typeof arg === "string" && arg.includes("Maximum update depth exceeded"),
          ),
        ),
      ).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("preserves restored waiting state when the selected thread stream initializes", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

    renderHook(threadId, {
      initialWaitingAssistant: { threadId, afterIdx: 12 },
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(latestWaitingAssistant).toEqual({ threadId, afterIdx: 12 });
  });

  it("patches the selected thread status snapshot to waiting_approval on active-thread permission requests", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

    renderHook(threadId);

    await act(async () => {
      await Promise.resolve();
    });

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit(
        "permission.requested",
        makeEvent({
          id: "e1",
          threadId,
          idx: 1,
          type: "permission.requested",
          payload: { requestId: "perm-1", toolName: "Bash" },
        }),
      );
    });

    expect(queryClient.getQueryData(queryKeys.threads.statusSnapshot(threadId))).toEqual({
      status: "waiting_approval",
      newestIdx: 1,
    });
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.threads.timelineSnapshot(threadId) });
  });

  it("patches the selected thread status snapshot to review_plan on active-thread plan.created events", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

    renderHook(threadId);

    await act(async () => {
      await Promise.resolve();
    });

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit(
        "plan.created",
        makeEvent({
          id: "e2",
          threadId,
          idx: 2,
          type: "plan.created",
          payload: { content: "Plan", filePath: "/tmp/plan.md" },
        }),
      );
    });

    expect(queryClient.getQueryData(queryKeys.threads.statusSnapshot(threadId))).toEqual({
      status: "review_plan",
      newestIdx: 2,
    });
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.threads.timelineSnapshot(threadId) });
  });

  it("patches the selected thread status snapshot to idle and refreshes the timeline on chat.completed", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

    renderHook(threadId);

    await act(async () => {
      await Promise.resolve();
    });

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit(
        "chat.completed",
        makeEvent({
          id: "e-complete",
          threadId,
          idx: 4,
          type: "chat.completed",
          payload: { messageId: "msg-1", threadTitle: "Done" },
        }),
      );
    });

    expect(queryClient.getQueryData(queryKeys.threads.statusSnapshot(threadId))).toEqual({
      status: "idle",
      newestIdx: 4,
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.threads.timelineSnapshot(threadId) });
  });

  it.each(["tool.started", "tool.finished", "subagent.started", "subagent.finished"] as const)(
    "patches the selected thread status snapshot to running on active-thread %s events",
    async (type) => {
      const threadId = "selected-thread";
      queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

      renderHook(threadId);

      await act(async () => {
        await Promise.resolve();
      });

      const stream = MockEventSource.instances[0]!;
      act(() => {
        stream.emit(
          type,
          makeEvent({
            id: `e-${type}`,
            threadId,
            idx: 5,
            type,
            payload: type.startsWith("subagent")
              ? { agentId: "agent-1", toolUseId: "task-1" }
              : { toolUseId: "tool-1", toolName: "Read" },
          }),
        );
      });

      expect(queryClient.getQueryData(queryKeys.threads.statusSnapshot(threadId))).toEqual({
        status: "running",
        newestIdx: 5,
      });
      expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.threads.timelineSnapshot(threadId) });
    },
  );

  it.each(["tool.started", "tool.output", "tool.finished"] as const)(
    "patches selected thread as active on %s",
    async (type) => {
      const threadId = "selected-thread";
      queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());
      queryClient.setQueryData(queryKeys.threads.list("wt-1"), [
        {
          id: threadId,
          worktreeId: "wt-1",
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
        } satisfies ChatThread,
      ]);

      renderHook(threadId);

      await act(async () => {
        await Promise.resolve();
      });

      const stream = MockEventSource.instances[0]!;
      act(() => {
        stream.emit(
          type,
          makeEvent({
            id: `event-${type}`,
            threadId,
            idx: 4,
            type,
            payload: type === "tool.finished" ? { toolName: "Read" } : {},
          }),
        );
      });

      const updated = queryClient.getQueryData<ChatThread[]>(queryKeys.threads.list("wt-1"));
      expect(updated?.[0]?.active).toBe(true);
    },
  );

  it("does not patch selected thread as active for delayed metadata tool.finished", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());
    queryClient.setQueryData(queryKeys.threads.list("wt-1"), [
      {
        id: threadId,
        worktreeId: "wt-1",
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
      } satisfies ChatThread,
    ]);

    renderHook(threadId);

    await act(async () => {
      await Promise.resolve();
    });

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit(
        "tool.finished",
        makeEvent({
          id: "e-metadata-finished",
          threadId,
          idx: 6,
          type: "tool.finished",
          payload: {
            source: "chat.thread.metadata",
            threadTitle: "Renamed thread",
          },
        }),
      );
    });

    const updated = queryClient.getQueryData<ChatThread[]>(queryKeys.threads.list("wt-1"));
    expect(updated?.[0]?.active).toBe(false);
    expect(updated?.[0]?.title).toBe("Renamed thread");
  });

  it("patches selected thread as inactive on chat.completed", async () => {
    const threadId = "selected-thread";
    const initialThreads: ChatThread[] = [
      {
        id: threadId,
        worktreeId: "wt-1",
        title: "Thread",
        kind: "default",
        permissionProfile: "default",
        permissionMode: "default",
        mode: "default",
        titleEditedManually: false,
        claudeSessionId: null,
        active: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());
    queryClient.setQueryData(queryKeys.threads.list("wt-1"), initialThreads);

    renderHook(threadId, { initialThreads });

    await act(async () => {
      await Promise.resolve();
    });

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit(
        "chat.completed",
        makeEvent({
          id: "e-complete-2",
          threadId,
          idx: 5,
          type: "chat.completed",
          payload: { messageId: "msg-2", threadTitle: "Done" },
        }),
      );
    });

    const updated = queryClient.getQueryData<ChatThread[]>(queryKeys.threads.list("wt-1"));
    expect(updated?.[0]?.active).toBe(false);
    expect(updated?.[0]?.title).toBe("Done");
    expect(latestThreads[0]?.active).toBe(false);
    expect(latestThreads[0]?.title).toBe("Done");
  });

  it.each(["chat.completed", "chat.failed"] as const)(
    "invalidates repository reviews when selected PR/MR thread receives %s",
    async (type) => {
      const threadId = "selected-thread";
      queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

      renderHook(threadId, { repositoryId: "repo-1", selectedThreadIsPrMr: true });

      await act(async () => {
        await Promise.resolve();
      });

      const stream = MockEventSource.instances[0]!;
      act(() => {
        stream.emit(
          type,
          makeEvent({
            id: `event-${type}`,
            threadId,
            idx: 5,
            type,
            payload: type === "chat.completed" ? { messageId: "msg-2", threadTitle: "Done" } : { error: "boom" },
          }),
        );
      });

      expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.repositories.reviews("repo-1") });
    },
  );

  it("does not reopen the stream when repository or review metadata changes for the same thread", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

    renderHook(threadId, { repositoryId: "repo-1", selectedThreadIsPrMr: false });

    await act(async () => {
      await Promise.resolve();
    });

    expect(MockEventSource.instances).toHaveLength(1);

    renderHook(threadId, { repositoryId: "repo-2", selectedThreadIsPrMr: true });

    await act(async () => {
      await Promise.resolve();
    });

    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("does not invalidate repository reviews for non-PR/MR selected threads", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

    renderHook(threadId, { repositoryId: "repo-1", selectedThreadIsPrMr: false });

    await act(async () => {
      await Promise.resolve();
    });

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit(
        "chat.completed",
        makeEvent({
          id: "non-prmr-complete",
          threadId,
          idx: 5,
          type: "chat.completed",
          payload: { messageId: "msg-2", threadTitle: "Done" },
        }),
      );
    });

    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.repositories.reviews("repo-1") });
  });

  it("patches selected thread as inactive on chat.failed", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());
    queryClient.setQueryData(queryKeys.threads.list("wt-1"), [
      {
        id: threadId,
        worktreeId: "wt-1",
        title: "Thread",
        kind: "default",
        permissionProfile: "default",
        permissionMode: "default",
        mode: "default",
        titleEditedManually: false,
        claudeSessionId: null,
        active: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } satisfies ChatThread,
    ]);

    renderHook(threadId);

    await act(async () => {
      await Promise.resolve();
    });

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit(
        "chat.failed",
        makeEvent({
          id: "e-failed-1",
          threadId,
          idx: 6,
          type: "chat.failed",
          payload: { error: "boom" },
        }),
      );
    });

    const updated = queryClient.getQueryData<ChatThread[]>(queryKeys.threads.list("wt-1"));
    expect(updated?.[0]?.active).toBe(false);
  });

  it.each(["tool.started", "tool.output", "tool.finished"] as const)(
    "clears waiting assistant on %s when idx advances",
    async (type) => {
      const threadId = "selected-thread";
      queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

      renderHook(threadId, {
        initialWaitingAssistant: { threadId, afterIdx: 12 },
      });

      await act(async () => {
        await Promise.resolve();
      });

      const stream = MockEventSource.instances[0]!;
      act(() => {
        stream.emit(
          type,
          makeEvent({
            id: `e-${type}`,
            threadId,
            idx: 13,
            type,
            payload: { toolUseId: "tu-1", toolName: "Bash" },
          }),
        );
      });

      expect(latestWaitingAssistant).toBeNull();
    },
  );

  it("keeps waiting assistant when tool event idx does not advance", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

    renderHook(threadId, {
      initialWaitingAssistant: { threadId, afterIdx: 12 },
    });

    await act(async () => {
      await Promise.resolve();
    });

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit(
        "tool.started",
        makeEvent({
          id: "e-tool-no-advance",
          threadId,
          idx: 12,
          type: "tool.started",
          payload: { toolUseId: "tu-1", toolName: "Bash" },
        }),
      );
    });

    expect(latestWaitingAssistant).toEqual({ threadId, afterIdx: 12 });
  });

  it("keeps bootstrap fetch cancellation wired before thread deletion cleanup", async () => {
    const threadId = "selected-thread";
    getThreadStatusSnapshotMock.mockResolvedValueOnce({ status: "idle", newestIdx: 7 });

    renderHook(threadId);

    await act(async () => {
      await Promise.resolve();
    });

    expect(getThreadStatusSnapshotMock).toHaveBeenCalledWith(threadId);
    expect(cancelQueriesMock).not.toHaveBeenCalled();
  });

  it("waits for the bootstrap status snapshot before opening the first SSE stream", async () => {
    const threadId = "selected-thread";
    let resolveStatus: ((snapshot: { status: string; newestIdx: number | null }) => void) | null = null;
    const pendingStatus = new Promise<{ status: string; newestIdx: number | null }>((resolve) => {
      resolveStatus = resolve;
    });
    getThreadStatusSnapshotMock.mockReturnValueOnce(pendingStatus);

    renderHook(threadId, {
      initialWaitingAssistant: { threadId, afterIdx: 1 },
    });

    expect(MockEventSource.instances).toHaveLength(0);
    expect(latestWaitingAssistant).toEqual({ threadId, afterIdx: 1 });

    await act(async () => {
      resolveStatus?.({ status: "idle", newestIdx: 41 });
      await pendingStatus;
      await Promise.resolve();
    });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toContain("afterIdx=41");

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit(
        "tool.started",
        makeEvent({
          id: "e-bootstrap-live",
          threadId,
          idx: 42,
          type: "tool.started",
          payload: { toolUseId: "tu-1", toolName: "Bash" },
        }),
      );
    });

    expect(latestWaitingAssistant).toBeNull();
  });

  it("patches the selected thread status snapshot back to running on gate resolution events", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

    renderHook(threadId);

    await act(async () => {
      await Promise.resolve();
    });

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit(
        "permission.resolved",
        makeEvent({
          id: "e3",
          threadId,
          idx: 3,
          type: "permission.resolved",
          payload: { requestId: "perm-1", decision: "allow" },
        }),
      );
    });

    expect(queryClient.getQueryData(queryKeys.threads.statusSnapshot(threadId))).toEqual({
      status: "running",
      newestIdx: 3,
    });
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.threads.timelineSnapshot(threadId) });
  });

  it("writes stream batches into local thread collections without duplicating repeated events", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

    renderHook(threadId);

    await act(async () => {
      await Promise.resolve();
    });

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit(
        "message.delta",
        makeEvent({
          id: "e-message-1",
          threadId,
          idx: 1,
          type: "message.delta",
          payload: {
            messageId: "assistant-1",
            role: "assistant",
            delta: "Hello",
          },
        }),
      );
      stream.emit(
        "message.delta",
        makeEvent({
          id: "e-message-1",
          threadId,
          idx: 1,
          type: "message.delta",
          payload: {
            messageId: "assistant-1",
            role: "assistant",
            delta: "Hello",
          },
        }),
      );
    });

    const storedEvents = getThreadEventsCollection(threadId).toArray as ChatEvent[];
    const storedMessages = getThreadMessagesCollection(threadId).toArray;
    expect(storedEvents.map((event) => event.id)).toEqual(["e-message-1"]);
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0]?.content).toBe("Hello");
  });

  it("creates an assistant placeholder when tool events arrive before assistant text", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

    renderHook(threadId);

    await act(async () => {
      await Promise.resolve();
    });

    const stream = MockEventSource.instances[0]!;
    act(() => {
      stream.emit(
        "tool.started",
        makeEvent({
          id: "e-tool-1",
          threadId,
          idx: 1,
          type: "tool.started",
          payload: {
            messageId: "assistant-1",
            toolName: "Bash",
            toolUseId: "bash-1",
            command: "ls",
          },
        }),
      );
    });

    const storedMessages = getThreadMessagesCollection(threadId).toArray;
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0]).toMatchObject({
      id: "assistant-1",
      role: "assistant",
      content: "",
    });
  });

  it("reconnects with afterIdx from the local thread registry", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());

    renderHook(threadId);

    await act(async () => {
      await Promise.resolve();
    });

    const firstStream = MockEventSource.instances[0]!;
    act(() => {
      firstStream.emit(
        "tool.started",
        makeEvent({
          id: "e-reconnect-1",
          threadId,
          idx: 4,
          type: "tool.started",
          payload: { toolUseId: "tool-1", toolName: "Bash" },
        }),
      );
    });

    expect(firstStream.url).not.toContain("afterIdx=4");

    await act(async () => {
      firstStream.readyState = MockEventSource.CLOSED;
      firstStream.onerror?.();
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]?.url).toContain("afterIdx=4");
  });

  it("resyncs the selected thread from snapshots when the stream stays stale but backend progress has advanced", async () => {
    const threadId = "selected-thread";
    const startedEvent = makeEvent({
      id: "event-1",
      threadId,
      idx: 1,
      type: "tool.started",
      payload: { toolUseId: "tool-1", toolName: "Read" },
    });
    const finishedEvent = makeEvent({
      id: "event-8",
      threadId,
      idx: 8,
      type: "tool.finished",
      payload: { toolUseId: "tool-1", toolName: "Read", summary: "Read fresh.txt" },
    });
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot([
      startedEvent,
    ]));
    queryClient.setQueryData(queryKeys.threads.list("wt-1"), [
      {
        id: threadId,
        worktreeId: "wt-1",
        title: "Thread",
        kind: "default",
        permissionProfile: "default",
        permissionMode: "default",
        mode: "default",
        titleEditedManually: false,
        claudeSessionId: null,
        active: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } satisfies ChatThread,
    ]);
    getThreadStatusSnapshotMock.mockResolvedValueOnce({ status: "running", newestIdx: 8 });
    getTimelineSnapshotMock.mockResolvedValueOnce(makeSnapshot([startedEvent, finishedEvent]));

    renderHook(threadId, {
      initialWaitingAssistant: { threadId, afterIdx: 1 },
    });

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(8_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getThreadStatusSnapshotMock).toHaveBeenCalledWith(threadId);
    expect(getTimelineSnapshotMock).toHaveBeenCalledWith(threadId);
    expect(queryClient.getQueryData(queryKeys.threads.statusSnapshot(threadId))).toEqual({
      status: "running",
      newestIdx: 8,
    });
    expect(queryClient.getQueryData(queryKeys.threads.timelineSnapshot(threadId))).toEqual(expect.objectContaining({
      newestIdx: 8,
    }));
    expect((getThreadEventsCollection(threadId).toArray as ChatEvent[]).map((event) => event.id)).toEqual([
      "event-1",
      "event-8",
    ]);
    expect(latestWaitingAssistant).toBeNull();
  });
});
