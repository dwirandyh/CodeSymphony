import { useRef, useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatEvent,
  ChatMessage,
  ChatThread,
  ChatTimelineSnapshot,
} from "@codesymphony/shared-types";
import { queryKeys } from "../../../../lib/queryKeys";
import { useThreadEventStream } from "./useThreadEventStream";

const invalidateQueriesMock = vi.fn();


vi.mock("../../../../lib/logService", () => ({
  logService: {
    log: vi.fn(),
  },
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

const { runtimeBaseUrlMock, getTimelineSnapshotMock } = vi.hoisted(() => ({
  runtimeBaseUrlMock: "http://127.0.0.1:4331",
  getTimelineSnapshotMock: vi.fn(),
}));

vi.mock("../../../../lib/api", () => ({
  api: {
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
  initialWaitingAssistant = null,
}: {
  selectedThreadId: string | null;
  initialWaitingAssistant?: { threadId: string; afterIdx: number } | null;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [waitingAssistant, setWaitingAssistant] = useState<{ threadId: string; afterIdx: number } | null>(initialWaitingAssistant);
  const [stoppingThreadId, setStoppingThreadId] = useState<string | null>(null);
  const [stopRequestedThreadId, setStopRequestedThreadId] = useState<string | null>(null);

  latestWaitingAssistant = waitingAssistant;

  void messages;
  void events;
  void threads;
  void stoppingThreadId;
  void stopRequestedThreadId;

  const seenEventIdsByThreadRef = useRef(new Map<string, Set<string>>());
  const lastEventIdxByThreadRef = useRef(new Map<string, number>());
  const streamingMessageIdsRef = useRef(new Set<string>());
  const stickyRawFallbackMessageIdsRef = useRef(new Set<string>());
  const renderDecisionByMessageIdRef = useRef(new Map<string, string>());
  const pendingEventsRef = useRef<ChatEvent[]>([]);
  const pendingMessageMutationsRef = useRef([]);
  const rafIdRef = useRef<number | null>(null);

  useThreadEventStream({
    selectedThreadId,
    selectedWorktreeId: "wt-1",
    setMessages,
    setEvents,
    setThreads,
    setWaitingAssistant,
    setStoppingThreadId,
    setStopRequestedThreadId,
    seenEventIdsByThreadRef,
    lastEventIdxByThreadRef,
    streamingMessageIdsRef,
    stickyRawFallbackMessageIdsRef,
    renderDecisionByMessageIdRef,
    pendingEventsRef,
    pendingMessageMutationsRef,
    rafIdRef,
    onError: vi.fn(),
  });

  return null;
}

function renderHook(
  selectedThreadId: string | null,
  options?: { initialWaitingAssistant?: { threadId: string; afterIdx: number } | null },
) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookHarness
          selectedThreadId={selectedThreadId}
          initialWaitingAssistant={options?.initialWaitingAssistant}
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
  latestWaitingAssistant = null;
  invalidateQueriesMock.mockReset();
  getTimelineSnapshotMock.mockReset();
  getTimelineSnapshotMock.mockResolvedValue(makeSnapshot());
  queryClient.invalidateQueries = invalidateQueriesMock as typeof queryClient.invalidateQueries;

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

  it("does not invalidate the selected thread snapshot on active-thread permission requests", async () => {
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

    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  it("does not invalidate the selected thread snapshot on active-thread plan.created events", async () => {
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

    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  it("does not invalidate the selected thread snapshot on active-thread chat.completed events", async () => {
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

    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.threads.timelineSnapshot(threadId) });
  });

  it("patches selected thread as inactive on chat.completed", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());
    queryClient.setQueryData(queryKeys.threads.list("wt-1"), [
      {
        id: threadId,
        worktreeId: "wt-1",
        title: "Thread",
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
  });

  it("patches selected thread as inactive on chat.failed", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), makeSnapshot());
    queryClient.setQueryData(queryKeys.threads.list("wt-1"), [
      {
        id: threadId,
        worktreeId: "wt-1",
        title: "Thread",
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

  it("still invalidates the selected thread snapshot on gate resolution events", async () => {
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

    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.threads.timelineSnapshot(threadId) });
  });
});
