import { useRef, useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatEvent,
  ChatMessage,
  ChatThread,
  ChatThreadSnapshot,
} from "@codesymphony/shared-types";
import { queryKeys } from "../../../../lib/queryKeys";
import { useThreadEventStream } from "./useThreadEventStream";

const invalidateQueriesMock = vi.fn();

vi.mock("../../../../lib/debugLog", () => ({
  debugLog: vi.fn(),
}));

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

const { runtimeBaseUrlMock, getThreadSnapshotMock } = vi.hoisted(() => ({
  runtimeBaseUrlMock: "http://127.0.0.1:4331",
  getThreadSnapshotMock: vi.fn(),
}));

vi.mock("../../../../lib/api", () => ({
  api: {
    getThreadSnapshot: getThreadSnapshotMock,
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

function makeSnapshot(events: ChatEvent[] = []): ChatThreadSnapshot {
  return {
    messages: {
      data: [],
      pageInfo: {
        hasMoreOlder: false,
        nextBeforeSeq: null,
        oldestSeq: null,
        newestSeq: null,
      },
    },
    events: {
      data: events,
      pageInfo: {
        hasMoreOlder: false,
        nextBeforeIdx: null,
        oldestIdx: null,
        newestIdx: events.length ? events[events.length - 1]!.idx : null,
      },
    },
    watermarks: {
      newestSeq: null,
      newestIdx: events.length ? events[events.length - 1]!.idx : null,
    },
    coverage: {
      eventsStatus: "complete",
      recommendedBackfill: false,
      nextBeforeIdx: null,
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

function HookHarness({ selectedThreadId }: { selectedThreadId: string | null }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [waitingAssistant, setWaitingAssistant] = useState<{ threadId: string; afterIdx: number } | null>(null);
  const [hasMoreOlderMessages, setHasMoreOlderMessages] = useState(false);
  const [hasMoreOlderEvents, setHasMoreOlderEvents] = useState(false);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const [stoppingThreadId, setStoppingThreadId] = useState<string | null>(null);
  const [stopRequestedThreadId, setStopRequestedThreadId] = useState<string | null>(null);

  void messages;
  void events;
  void threads;
  void waitingAssistant;
  void hasMoreOlderMessages;
  void hasMoreOlderEvents;
  void loadingOlderHistory;
  void stoppingThreadId;
  void stopRequestedThreadId;

  const seenEventIdsByThreadRef = useRef(new Map<string, Set<string>>());
  const lastEventIdxByThreadRef = useRef(new Map<string, number>());
  const nextBeforeSeqByThreadRef = useRef(new Map<string, number | null>());
  const nextBeforeIdxByThreadRef = useRef(new Map<string, number | null>());
  const streamingMessageIdsRef = useRef(new Set<string>());
  const stickyRawFallbackMessageIdsRef = useRef(new Set<string>());
  const renderDecisionByMessageIdRef = useRef(new Map<string, string>());
  const loggedFirstInsertOrderByMessageIdRef = useRef(new Set<string>());
  const loadingOlderHistoryRef = useRef(false);
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
    setHasMoreOlderMessages,
    setHasMoreOlderEvents,
    setLoadingOlderHistory,
    setStoppingThreadId,
    setStopRequestedThreadId,
    seenEventIdsByThreadRef,
    lastEventIdxByThreadRef,
    nextBeforeSeqByThreadRef,
    nextBeforeIdxByThreadRef,
    streamingMessageIdsRef,
    stickyRawFallbackMessageIdsRef,
    renderDecisionByMessageIdRef,
    loggedFirstInsertOrderByMessageIdRef,
    loadingOlderHistoryRef,
    pendingEventsRef,
    pendingMessageMutationsRef,
    rafIdRef,
    onError: vi.fn(),
  });

  return null;
}

function renderHook(selectedThreadId: string | null) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookHarness selectedThreadId={selectedThreadId} />
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
  getThreadSnapshotMock.mockReset();
  getThreadSnapshotMock.mockResolvedValue(makeSnapshot());
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
  it("does not invalidate the selected thread snapshot on active-thread permission requests", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.snapshot(threadId), makeSnapshot());

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
    queryClient.setQueryData(queryKeys.threads.snapshot(threadId), makeSnapshot());

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
    queryClient.setQueryData(queryKeys.threads.snapshot(threadId), makeSnapshot());

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

    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  it("still invalidates the selected thread snapshot on gate resolution events", async () => {
    const threadId = "selected-thread";
    queryClient.setQueryData(queryKeys.threads.snapshot(threadId), makeSnapshot());

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

    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.threads.snapshot(threadId) });
  });
});
